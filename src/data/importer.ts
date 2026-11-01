import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { UFS } from '../domain/codes.ts';
import { Database, type SqlParam, sqlLiteral } from './database.ts';
import { COLUMNS, classifyFile, type FileKind, REQUIRED_KINDS } from './layout.ts';
import { forEachChunk } from './zip.ts';

export const SCHEMA_VERSION = '1';

const DEFAULT_CHUNK_BYTES = 128 * 1024 * 1024;

export interface ImportOptions {
  /** Folder with the monthly ZIP files published by Receita Federal. */
  sourceDir: string;
  databasePath: string;
  /** Keep only establishments in these states. Empty means the whole country. */
  states?: readonly string[];
  /** Reference month of the data (AAAA-MM). Inferred from sourceDir when omitted. */
  referenceMonth?: string;
  /** Folder for temporary files. Defaults to the database folder, never /tmp. */
  tempDir?: string;
  /** Size of the pieces the CSV files are processed in. */
  chunkBytes?: number;
  log?: (message: string) => void;
}

export interface ImportSummary {
  databasePath: string;
  establishments: number;
  states: string[];
  referenceMonth: string | null;
}

export class ImportError extends Error {
  override name = 'ImportError';
}

type DatasetFiles = Record<FileKind, string[]>;

/**
 * Imports the Receita Federal ZIP files into a DuckDB database optimized for
 * search.
 *
 * The database is built in a temporary file and swapped in at the end, so a
 * failed import never corrupts the current one. Raw tables live in a separate
 * staging file that is deleted afterwards, keeping the final database compact,
 * and archives are processed in bounded chunks so the whole country fits in a
 * regular disk.
 */
export async function importDataset(options: ImportOptions): Promise<ImportSummary> {
  const log = options.log ?? (() => {});
  const states = normalizeStates(options.states ?? []);
  const referenceMonth = options.referenceMonth ?? inferReferenceMonth(options.sourceDir);
  const files = await discoverFiles(options.sourceDir);

  const tempPath = `${options.databasePath}.importing`;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const tempDir = options.tempDir ?? dirname(options.databasePath);
  await mkdir(dirname(options.databasePath), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await removeDatabase(tempPath);
  const workDir = await mkdtemp(join(tempDir, '.radar-import-'));
  const db = await Database.open(tempPath);

  let establishments: number;
  try {
    await db.run(`SET temp_directory = ${sqlLiteral(join(workDir, 'spill'))}`);
    await db.run(`ATTACH ${sqlLiteral(join(workDir, 'staging.duckdb'))} AS raw`);
    await createRawTables(db);

    const stateFilter = states.length > 0 ? `WHERE uf IN (${placeholders(states.length)})` : '';
    for (const zip of files.estabelecimentos) {
      log(`Importando ${basename(zip)}...`);
      await loadZip(db, 'estabelecimentos', zip, workDir, chunkBytes, stateFilter, states);
    }

    const companyFilter =
      states.length > 0
        ? 'WHERE cnpj_basico IN (SELECT DISTINCT cnpj_basico FROM raw.estabelecimentos)'
        : '';
    for (const kind of ['empresas', 'simples', 'cnaes', 'municipios'] as const) {
      const filter = kind === 'empresas' || kind === 'simples' ? companyFilter : '';
      for (const zip of files[kind]) {
        log(`Importando ${basename(zip)}...`);
        await loadZip(db, kind, zip, workDir, chunkBytes, filter, []);
      }
    }

    log('Montando a base de busca...');
    await buildSearchTables(db, log);
    await writeMetadata(db, { states, referenceMonth });
    await db.run('DETACH raw');
    await db.run('CHECKPOINT');

    const [row] = await db.all<{ total: number }>(
      'SELECT count(*)::INTEGER AS total FROM estabelecimentos',
    );
    establishments = row?.total ?? 0;
  } catch (error) {
    db.close();
    await removeDatabase(tempPath);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  db.close();
  await removeDatabase(options.databasePath);
  await rename(tempPath, options.databasePath);

  return { databasePath: options.databasePath, establishments, states, referenceMonth };
}

/** Finds and classifies the dataset files in a folder. */
export async function discoverFiles(sourceDir: string): Promise<DatasetFiles> {
  const files: DatasetFiles = {
    estabelecimentos: [],
    empresas: [],
    simples: [],
    cnaes: [],
    municipios: [],
  };

  let names: string[];
  try {
    names = await readdir(sourceDir);
  } catch {
    throw new ImportError(`Pasta não encontrada: ${sourceDir}`);
  }

  for (const name of names.sort()) {
    const kind = classifyFile(name);
    if (kind) {
      files[kind].push(join(sourceDir, name));
    }
  }

  const missing = REQUIRED_KINDS.filter((kind) => files[kind].length === 0);
  if (missing.length > 0) {
    throw new ImportError(
      `Arquivos ausentes em ${sourceDir}: ${missing.join(', ')}. ` +
        'Baixe a pasta do mês em "Dados Abertos do CNPJ" da Receita Federal.',
    );
  }
  return files;
}

function normalizeStates(states: readonly string[]): string[] {
  const normalized = [...new Set(states.map((state) => state.trim().toUpperCase()))];
  const invalid = normalized.filter((state) => !(UFS as readonly string[]).includes(state));
  if (invalid.length > 0) {
    throw new ImportError(`UF inválida: ${invalid.join(', ')}`);
  }
  return normalized.sort();
}

function inferReferenceMonth(sourceDir: string): string | null {
  return /(\d{4}-\d{2})/.exec(basename(sourceDir))?.[1] ?? null;
}

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `$${start + i}`).join(', ');
}

async function createRawTables(db: Database): Promise<void> {
  for (const [kind, columns] of Object.entries(COLUMNS)) {
    const definition = columns.map((column) => `${column} VARCHAR`).join(', ');
    await db.run(`CREATE TABLE raw.${kind} (${definition})`);
  }
}

async function loadZip(
  db: Database,
  kind: FileKind,
  zipPath: string,
  workDir: string,
  chunkBytes: number,
  where: string,
  params: SqlParam[],
): Promise<void> {
  await forEachChunk(zipPath, workDir, chunkBytes, (csv) =>
    db.run(`INSERT INTO raw.${kind} SELECT * FROM ${readCsv(csv, kind)} ${where}`, params),
  );
}

function readCsv(path: string, kind: FileKind): string {
  const columns = COLUMNS[kind].map((column) => `'${column}': 'VARCHAR'`).join(', ');
  return (
    `read_csv(${sqlLiteral(path)}, delim = ';', header = false, quote = '"', escape = '"', ` +
    `encoding = 'latin-1', columns = {${columns}})`
  );
}

const SEARCH_SELECT = `
    SELECT
      e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv AS cnpj,
      e.cnpj_basico,
      e.identificador_matriz_filial = '1' AS matriz,
      NULLIF(trim(e.nome_fantasia), '') AS nome_fantasia,
      e.situacao_cadastral AS situacao,
      try_strptime(e.data_situacao_cadastral, '%Y%m%d')::DATE AS data_situacao,
      try_strptime(e.data_inicio_atividade, '%Y%m%d')::DATE AS data_abertura,
      e.cnae_fiscal_principal AS cnae_principal,
      c.descricao AS cnae_descricao,
      CASE
        WHEN coalesce(trim(e.cnae_fiscal_secundaria), '') = '' THEN []::VARCHAR[]
        ELSE string_split(e.cnae_fiscal_secundaria, ',')
      END AS cnaes_secundarios,
      NULLIF(concat_ws(', ',
        NULLIF(trim(concat_ws(' ', NULLIF(trim(e.tipo_logradouro), ''), NULLIF(trim(e.logradouro), ''))), ''),
        NULLIF(trim(e.numero), ''),
        NULLIF(trim(e.complemento), '')
      ), '') AS endereco,
      NULLIF(trim(e.bairro), '') AS bairro,
      strip_accents(upper(coalesce(trim(e.bairro), ''))) AS bairro_norm,
      NULLIF(trim(e.cep), '') AS cep,
      e.uf,
      e.municipio AS municipio_codigo,
      m.descricao AS municipio,
      strip_accents(upper(coalesce(trim(m.descricao), ''))) AS municipio_norm,
      NULLIF(trim(e.ddd_1), '') AS ddd_1,
      NULLIF(trim(e.telefone_1), '') AS telefone_1,
      NULLIF(trim(e.ddd_2), '') AS ddd_2,
      NULLIF(trim(e.telefone_2), '') AS telefone_2,
      NULLIF(lower(trim(e.correio_eletronico)), '') AS email,
      NULLIF(trim(em.razao_social), '') AS razao_social,
      em.natureza_juridica,
      TRY_CAST(replace(em.capital_social, ',', '.') AS DOUBLE) AS capital_social,
      em.porte_empresa AS porte,
      coalesce(s.opcao_simples = 'S', false) AS simples,
      coalesce(s.opcao_mei = 'S', false) AS mei
    FROM raw.estabelecimentos e
    LEFT JOIN raw.empresas em ON em.cnpj_basico = e.cnpj_basico
    LEFT JOIN raw.simples s ON s.cnpj_basico = e.cnpj_basico
    LEFT JOIN raw.cnaes c ON c.codigo = e.cnae_fiscal_principal
    LEFT JOIN raw.municipios m ON m.codigo = e.municipio`;

/**
 * Builds the search table one state at a time, sorted by city and activity.
 * Clustering lets DuckDB skip whole blocks when filtering, and building per
 * state keeps memory and spill space bounded by the largest state.
 */
async function buildSearchTables(db: Database, log: (message: string) => void): Promise<void> {
  await db.run(`CREATE TABLE estabelecimentos AS ${SEARCH_SELECT} LIMIT 0`);

  const states = await db.all<{ uf: string | null }>(
    'SELECT DISTINCT uf FROM raw.estabelecimentos ORDER BY uf NULLS LAST',
  );
  for (const { uf } of states) {
    log(`Organizando ${uf ?? 'sem UF'}...`);
    await db.run(
      `INSERT INTO estabelecimentos ${SEARCH_SELECT}
       WHERE e.uf IS NOT DISTINCT FROM $1
       ORDER BY e.municipio, e.cnae_fiscal_principal`,
      [uf],
    );
  }

  await db.run(`
    CREATE TABLE cnaes AS
    SELECT codigo, descricao, strip_accents(upper(descricao)) AS descricao_norm
    FROM raw.cnaes
  `);

  await db.run(`
    CREATE TABLE municipios AS
    SELECT DISTINCT municipio_codigo AS codigo, municipio AS nome, municipio_norm AS nome_norm, uf
    FROM estabelecimentos
    WHERE municipio IS NOT NULL
  `);
}

async function writeMetadata(
  db: Database,
  metadata: { states: string[]; referenceMonth: string | null },
): Promise<void> {
  await db.run('CREATE TABLE metadados (chave VARCHAR PRIMARY KEY, valor VARCHAR)');
  const entries: [string, string | null][] = [
    ['versao_esquema', SCHEMA_VERSION],
    ['mes_referencia', metadata.referenceMonth],
    ['ufs', metadata.states.join(',')],
    ['importado_em', new Date().toISOString()],
  ];
  for (const [key, value] of entries) {
    await db.run('INSERT INTO metadados VALUES ($1, $2)', [key, value]);
  }
}

async function removeDatabase(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.wal`, { force: true });
}
