import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { importDataset } from './importer.ts';
import { classifyFile, REQUIRED_KINDS } from './layout.ts';

/** Public share of Receita Federal, as shown in the browser address bar. */
export const DEFAULT_SHARE_URL =
  'https://arquivos.receitafederal.gov.br/index.php/s/gn672Ad4CF8N6TK?dir=/Dados/Cadastros/CNPJ';

const WORK_DIR_PREFIX = '.radar-download-';
const DOWNLOAD_ATTEMPTS = 3;
const PARALLEL_DOWNLOADS = 4;
/** The import needs room for a staging copy and sorting: measured peak of about twice the ZIPs. */
const IMPORT_SPACE_FACTOR = 2;
const MANUAL_HINT =
  'Você também pode baixar os arquivos pelo navegador e usar "radar-cnpj-mcp importar"; veja o README.';

export interface DownloadOptions {
  databasePath: string;
  /** States to keep. Empty means the whole country. */
  states: readonly string[];
  /** Reference month (AAAA-MM). Defaults to the latest one published. */
  month?: string;
  /** Link of the Receita Federal share. Defaults to DEFAULT_SHARE_URL. */
  shareUrl?: string;
  /** Keeps the ZIP files in this folder, reusing the ones already complete. */
  keepDir?: string;
  tempDir?: string;
  memoryLimit?: string;
  log?: (message: string) => void;
}

export interface DownloadSummary {
  databasePath: string;
  establishments: number;
  states: string[];
  referenceMonth: string;
  downloadedBytes: number;
}

export class DownloadError extends Error {
  override name = 'DownloadError';
}

interface Share {
  webdavUrl: string;
  authorization: string;
}

interface RemoteEntry {
  name: string;
  size: number;
  isDirectory: boolean;
}

/** Turns the share link people see in the browser into its WebDAV endpoint. */
export function parseShareUrl(shareUrl: string): Share {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    throw new DownloadError(`Link inválido da Receita Federal: ${shareUrl}`);
  }
  const token = /\/s\/([^/?]+)/.exec(url.pathname)?.[1];
  const dir = url.searchParams.get('dir');
  if (!token || !dir) {
    throw new DownloadError(
      `Link inválido da Receita Federal: ${shareUrl}. Use o endereço da pasta do CNPJ no navegador.`,
    );
  }
  return {
    webdavUrl: `${url.origin}/public.php/webdav${dir.replace(/\/$/, '')}`,
    authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
  };
}

/** Downloads the month's files from Receita Federal and imports the requested states. */
export async function downloadDataset(options: DownloadOptions): Promise<DownloadSummary> {
  const log = options.log ?? (() => {});
  const share = parseShareUrl(options.shareUrl ?? DEFAULT_SHARE_URL);

  const { month, files } = await withManualHint(() => listMonth(share, options.month));

  const tempDir = options.tempDir ?? dirname(options.databasePath);
  await mkdir(tempDir, { recursive: true });
  await removeStaleWorkDirs(tempDir);
  const workDir = options.keepDir
    ? join(options.keepDir, month)
    : await mkdtemp(join(tempDir, WORK_DIR_PREFIX));
  await mkdir(workDir, { recursive: true });

  try {
    const pending = await filesToDownload(files, workDir);
    const bytes = pending.reduce((sum, file) => sum + file.size, 0);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    await ensureFreeSpace(workDir, bytes + totalBytes * IMPORT_SPACE_FACTOR);

    log(`Mês ${month}: baixando ${pending.length} arquivos da Receita (${formatBytes(bytes)})...`);
    await withManualHint(() =>
      inParallel(pending, PARALLEL_DOWNLOADS, async (file) => {
        await downloadFile(share, month, file, workDir);
        log(`Baixado ${file.name} (${formatBytes(file.size)})`);
      }),
    );

    const summary = await importDataset({
      sourceDir: workDir,
      databasePath: options.databasePath,
      states: options.states,
      referenceMonth: month,
      tempDir,
      ...(options.memoryLimit ? { memoryLimit: options.memoryLimit } : {}),
      log,
    });
    return {
      databasePath: summary.databasePath,
      establishments: summary.establishments,
      states: summary.states,
      referenceMonth: month,
      downloadedBytes: bytes,
    };
  } finally {
    if (!options.keepDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function listMonth(
  share: Share,
  requested: string | undefined,
): Promise<{ month: string; files: RemoteEntry[] }> {
  const month = requested ?? (await latestMonth(share));
  const files = (await listDirectory(share, month)).filter(
    (entry) => !entry.isDirectory && classifyFile(entry.name),
  );
  const missing = REQUIRED_KINDS.filter(
    (kind) => !files.some((file) => classifyFile(file.name) === kind),
  );
  if (missing.length > 0) {
    throw new DownloadError(`A pasta ${month} da Receita não tem: ${missing.join(', ')}.`);
  }
  return { month, files };
}

async function withManualHint<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof DownloadError) {
      throw new DownloadError(`${error.message} ${MANUAL_HINT}`);
    }
    throw error;
  }
}

async function latestMonth(share: Share): Promise<string> {
  const months = (await listDirectory(share))
    .filter((entry) => entry.isDirectory && /^\d{4}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const latest = months.at(-1);
  if (!latest) {
    throw new DownloadError('Nenhum mês encontrado na Receita Federal.');
  }
  return latest;
}

async function listDirectory(share: Share, month?: string): Promise<RemoteEntry[]> {
  const url = month ? `${share.webdavUrl}/${month}/` : `${share.webdavUrl}/`;
  const response = await request(url, {
    method: 'PROPFIND',
    headers: { Authorization: share.authorization, Depth: '1' },
  });
  if (response.status === 404 && month) {
    throw new DownloadError(`Não há dados do mês ${month} na Receita Federal.`);
  }
  if (!response.ok) {
    throw new DownloadError(
      `A Receita Federal respondeu HTTP ${response.status} ao listar os arquivos. ` +
        'Se o link mudou, informe o novo em RADAR_CNPJ_RECEITA_URL.',
    );
  }
  return parseListing(await response.text());
}

/** Reads a WebDAV listing, leaving out the folder being listed. */
export function parseListing(xml: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  for (const [block] of xml.matchAll(/<d:response>[\s\S]*?<\/d:response>/g)) {
    const href = /<d:href>([^<]+)<\/d:href>/.exec(block)?.[1];
    if (!href) {
      continue;
    }
    const isDirectory = block.includes('<d:collection');
    const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() ?? '');
    const size = Number(/<d:getcontentlength>(\d+)</.exec(block)?.[1] ?? 0);
    entries.push({ name, size, isDirectory });
  }
  return entries.slice(1);
}

async function filesToDownload(files: RemoteEntry[], dir: string): Promise<RemoteEntry[]> {
  const pending: RemoteEntry[] = [];
  for (const file of files) {
    const local = await stat(join(dir, file.name)).catch(() => null);
    if (local?.size !== file.size) {
      pending.push(file);
    }
  }
  return pending;
}

async function ensureFreeSpace(dir: string, bytes: number): Promise<void> {
  const { bavail, bsize } = await statfs(dir);
  const free = bavail * bsize;
  if (free < bytes) {
    throw new DownloadError(
      `Espaço insuficiente: o download e a importação precisam de cerca de ${formatBytes(bytes)} ` +
        `e há ${formatBytes(free)} livres.`,
    );
  }
}

async function downloadFile(
  share: Share,
  month: string,
  file: RemoteEntry,
  dir: string,
): Promise<void> {
  const target = join(dir, file.name);
  const partial = `${target}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      await streamToFile(`${share.webdavUrl}/${month}/${file.name}`, share, partial);
      const { size } = await stat(partial);
      if (size !== file.size) {
        throw new DownloadError(`${file.name} veio incompleto (${size} de ${file.size} bytes).`);
      }
      await rename(partial, target);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  await rm(partial, { force: true });
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new DownloadError(`Falha ao baixar ${file.name}: ${reason}`);
}

async function streamToFile(url: string, share: Share, path: string): Promise<void> {
  const response = await request(url, { headers: { Authorization: share.authorization } });
  if (!response.ok || !response.body) {
    throw new DownloadError(`HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(path));
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DownloadError(`Não foi possível acessar a Receita Federal (${reason}).`);
  }
}

async function inParallel<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  // Waits for every worker, so nothing is still writing when the caller cleans up.
  const results = await Promise.allSettled(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          await worker(item);
        } catch (error) {
          queue.length = 0;
          throw error;
        }
      }
    }),
  );
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

async function removeStaleWorkDirs(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(WORK_DIR_PREFIX)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}
