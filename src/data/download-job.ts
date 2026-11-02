import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DownloadStatus {
  estado: 'baixando' | 'concluido' | 'erro' | 'interrompido';
  /** Requested states. Empty means the whole country. */
  ufs: string[];
  mes: string | null;
  iniciado_em: string;
  atualizado_em: string;
  /** Last step reported by the download. */
  etapa: string;
  pid: number;
  estabelecimentos?: number;
  mes_referencia?: string;
  erro?: string;
}

export interface StartDownloadOptions {
  databasePath: string;
  /** Script of this CLI, run again as a separate process. */
  cliPath: string;
  states: readonly string[];
  month?: string | undefined;
}

export function downloadStatusPath(databasePath: string): string {
  return `${databasePath}.download.json`;
}

/**
 * Starts the download in a separate process, since it takes longer than a tool
 * call and must survive the agent closing. Does nothing if one is already running.
 */
export async function startDownload(
  options: StartDownloadOptions,
): Promise<{ iniciado: boolean; status: DownloadStatus }> {
  const statusPath = downloadStatusPath(options.databasePath);
  const current = await readDownloadStatus(statusPath);
  if (current?.estado === 'baixando') {
    return { iniciado: false, status: current };
  }

  const now = new Date().toISOString();
  const status: DownloadStatus = {
    estado: 'baixando',
    ufs: [...options.states],
    mes: options.month ?? null,
    iniciado_em: now,
    atualizado_em: now,
    etapa: 'Iniciando...',
    pid: process.pid,
  };
  await mkdir(dirname(statusPath), { recursive: true });
  await writeDownloadStatus(statusPath, status);

  const child = spawn(
    process.execPath,
    [
      options.cliPath,
      'baixar',
      ...(options.states.length > 0 ? ['--ufs', options.states.join(',')] : ['--todas']),
      ...(options.month ? ['--mes', options.month] : []),
      '--status-arquivo',
      statusPath,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.once('error', (error) => {
    void writeDownloadStatus(statusPath, { ...status, estado: 'erro', erro: error.message });
  });
  child.unref();
  return { iniciado: true, status };
}

/** Reads the last download's status, or null if none ever ran. */
export async function readDownloadStatus(path: string): Promise<DownloadStatus | null> {
  let status: DownloadStatus;
  try {
    status = JSON.parse(await readFile(path, 'utf8')) as DownloadStatus;
  } catch {
    return null;
  }
  return status.estado === 'baixando' && !isRunning(status.pid)
    ? { ...status, estado: 'interrompido' }
    : status;
}

/** Keeps the status file up to date from inside the download process. */
export class DownloadStatusWriter {
  private readonly path: string;
  private status: DownloadStatus;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string, states: readonly string[], month: string | undefined) {
    this.path = path;
    const now = new Date().toISOString();
    this.status = {
      estado: 'baixando',
      ufs: [...states],
      mes: month ?? null,
      iniciado_em: now,
      atualizado_em: now,
      etapa: 'Iniciando...',
      pid: process.pid,
    };
    this.save();
  }

  step(etapa: string): void {
    this.update({ etapa });
  }

  finish(result: { estabelecimentos: number; mes_referencia: string }): Promise<void> {
    this.update({ estado: 'concluido', etapa: 'Base pronta.', ...result });
    return this.writing;
  }

  fail(error: unknown): Promise<void> {
    const erro = error instanceof Error ? error.message : String(error);
    this.update({ estado: 'erro', erro });
    return this.writing;
  }

  private update(changes: Partial<DownloadStatus>): void {
    this.status = { ...this.status, ...changes, atualizado_em: new Date().toISOString() };
    this.save();
  }

  private save(): void {
    const status = this.status;
    // In order, and never failing the download: this file is only informative.
    this.writing = this.writing.then(() => writeDownloadStatus(this.path, status)).catch(() => {});
  }
}

async function writeDownloadStatus(path: string, status: DownloadStatus): Promise<void> {
  const partial = `${path}.${process.pid}.tmp`;
  await writeFile(partial, JSON.stringify(status, null, 2));
  await rename(partial, path);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
