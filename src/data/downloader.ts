import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Database, sqlLiteral } from './database.ts';
import { defaultMemoryLimit, normalizeStates, removeDatabase, writeMetadata } from './importer.ts';
import {
  CHECKSUMS_FILE,
  CNAES_FILE,
  DEFAULT_DATA_REPO,
  establishmentsFile,
  METADATA_FILE,
  MUNICIPALITIES_FILE,
  parseChecksums,
  type ReleaseMetadata,
  releaseTag,
} from './release.ts';

const USER_AGENT = 'radar-cnpj-mcp';
const WORK_DIR_PREFIX = '.radar-download-';

export interface DownloadOptions {
  databasePath: string;
  /** States to download. At least one. */
  states: readonly string[];
  /** Reference month (AAAA-MM). Defaults to the latest release. */
  month?: string;
  /** GitHub repository holding the releases. */
  repo?: string;
  /** GitHub API base URL, overridable for tests. */
  apiBaseUrl?: string;
  /** Folder for temporary files. Defaults to the database folder. */
  tempDir?: string;
  memoryLimit?: string;
  log?: (message: string) => void;
}

export interface DownloadSummary {
  databasePath: string;
  establishments: number;
  states: string[];
  referenceMonth: string | null;
  downloadedBytes: number;
}

export class DownloadError extends Error {
  override name = 'DownloadError';
}

interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

/**
 * Builds the local database from the ready-made Parquet files of the
 * radar-cnpj-dados releases, downloading only the requested states. Every file
 * is checked against SHA256SUMS, and the database is swapped in only at the end.
 */
export async function downloadDataset(options: DownloadOptions): Promise<DownloadSummary> {
  const log = options.log ?? (() => {});
  const states = normalizeStates(options.states);
  if (states.length === 0) {
    throw new DownloadError('Informe ao menos uma UF, ex.: --ufs SP');
  }

  const release = await fetchRelease(options);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const missing = states.filter((uf) => !assets.has(establishmentsFile(uf)));
  if (missing.length > 0) {
    const available = release.assets
      .map((asset) => /^estabelecimentos-(.+)\.parquet$/.exec(asset.name)?.[1])
      .filter(Boolean)
      .join(', ');
    throw new DownloadError(
      `UF ${missing.join(', ')} não existe no release ${release.tag_name}. Disponíveis: ${available}.`,
    );
  }
  for (const name of [CHECKSUMS_FILE, METADATA_FILE, CNAES_FILE, MUNICIPALITIES_FILE]) {
    if (!assets.has(name)) {
      throw new DownloadError(`O release ${release.tag_name} não tem o arquivo ${name}.`);
    }
  }

  const tempDir = options.tempDir ?? dirname(options.databasePath);
  await mkdir(tempDir, { recursive: true });
  const workDir = await mkdtemp(join(tempDir, WORK_DIR_PREFIX));
  const tempPath = `${options.databasePath}.importing`;
  await removeDatabase(tempPath);

  try {
    log(`Release ${release.tag_name}`);
    // Filled by the first download; SHA256SUMS itself is not listed in it.
    let checksums: Map<string, string> | undefined;
    const fetchAsset = async (name: string): Promise<string> => {
      const asset = assets.get(name) as ReleaseAsset;
      log(`Baixando ${name} (${formatBytes(asset.size)})...`);
      const path = join(workDir, name);
      const hash = await downloadFile(asset.browser_download_url, path);
      if (checksums && checksums.get(name) !== hash) {
        throw new DownloadError(`O arquivo ${name} veio corrompido (SHA-256 não confere).`);
      }
      return path;
    };

    checksums = parseChecksums(await readFile(await fetchAsset(CHECKSUMS_FILE), 'utf8'));
    const metadata = JSON.parse(
      await readFile(await fetchAsset(METADATA_FILE), 'utf8'),
    ) as ReleaseMetadata;
    const cnaes = await fetchAsset(CNAES_FILE);
    const municipalities = await fetchAsset(MUNICIPALITIES_FILE);
    const establishments: string[] = [];
    for (const uf of states) {
      establishments.push(await fetchAsset(establishmentsFile(uf)));
    }

    log('Montando a base...');
    const db = await Database.open(tempPath);
    let total: number;
    try {
      await db.run(`SET temp_directory = ${sqlLiteral(join(workDir, 'spill'))}`);
      await db.run(`SET memory_limit = ${sqlLiteral(options.memoryLimit ?? defaultMemoryLimit())}`);
      total = await buildDatabase(db, { establishments, cnaes, municipalities, states });
      await writeMetadata(db, { states, referenceMonth: metadata.mes_referencia });
      await db.run('CHECKPOINT');
    } finally {
      db.close();
    }

    await removeDatabase(options.databasePath);
    await rename(tempPath, options.databasePath);

    const downloadedBytes = [CHECKSUMS_FILE, METADATA_FILE, CNAES_FILE, MUNICIPALITIES_FILE]
      .concat(states.map(establishmentsFile))
      .reduce((sum, name) => sum + (assets.get(name)?.size ?? 0), 0);
    return {
      databasePath: options.databasePath,
      establishments: total,
      states,
      referenceMonth: metadata.mes_referencia,
      downloadedBytes,
    };
  } catch (error) {
    await removeDatabase(tempPath);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function fetchRelease(options: DownloadOptions): Promise<Release> {
  const api = options.apiBaseUrl ?? 'https://api.github.com';
  const repo = options.repo ?? DEFAULT_DATA_REPO;
  const path = options.month ? `tags/${releaseTag(options.month)}` : 'latest';
  const response = await fetch(`${api}/repos/${repo}/releases/${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
  });
  if (response.status === 404) {
    throw new DownloadError(
      options.month
        ? `Não há dados do mês ${options.month} em ${repo}.`
        : `Nenhum release de dados encontrado em ${repo}.`,
    );
  }
  if (!response.ok) {
    throw new DownloadError(`Falha ao consultar ${repo}: HTTP ${response.status}.`);
  }
  return (await response.json()) as Release;
}

/** Streams a URL to disk and returns its SHA-256. */
async function downloadFile(url: string, path: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new DownloadError(`Falha ao baixar ${url}: HTTP ${response.status}.`);
  }
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) {
        await once(out, 'drain');
      }
    }
  } finally {
    out.end();
    await once(out, 'finish');
  }
  return hash.digest('hex');
}

async function buildDatabase(
  db: Database,
  files: { establishments: string[]; cnaes: string; municipalities: string; states: string[] },
): Promise<number> {
  // Each state's file is already sorted by city and activity; loading them in
  // order keeps the table clustered for fast filtering.
  const first = files.establishments[0] as string;
  await db.run(
    `CREATE TABLE estabelecimentos AS SELECT * FROM (${normalizedSelect(first)}) LIMIT 0`,
  );
  for (const file of files.establishments) {
    await db.run(`INSERT INTO estabelecimentos ${normalizedSelect(file)}`);
  }

  await db.run(
    `CREATE TABLE cnaes AS
     SELECT codigo, descricao, strip_accents(upper(descricao)) AS descricao_norm
     FROM read_parquet(${sqlLiteral(files.cnaes)})`,
  );
  await db.run(
    `CREATE TABLE municipios AS
     SELECT codigo, nome, strip_accents(upper(coalesce(trim(nome), ''))) AS nome_norm, uf
     FROM read_parquet(${sqlLiteral(files.municipalities)})
     WHERE uf IN (${files.states.map(sqlLiteral).join(', ')})`,
  );

  const [row] = await db.all<{ total: number }>(
    'SELECT count(*)::INTEGER AS total FROM estabelecimentos',
  );
  return row?.total ?? 0;
}

function normalizedSelect(file: string): string {
  return `SELECT *,
    strip_accents(upper(coalesce(trim(bairro), ''))) AS bairro_norm,
    strip_accents(upper(coalesce(trim(municipio), ''))) AS municipio_norm
  FROM read_parquet(${sqlLiteral(file)})`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
