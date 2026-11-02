import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type DownloadStatus,
  DownloadStatusWriter,
  downloadStatusPath,
  readDownloadStatus,
  startDownload,
} from '../src/data/download-job.ts';
import { importDataset } from '../src/data/importer.ts';
import { LazyRepositoryProvider } from '../src/data/provider.ts';
import { createDatasetFolder } from './fixtures.ts';

/** Stands in for the CLI: records its arguments, then waits for a file to appear. */
const FAKE_CLI = `
import { existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const statusPath = args[args.indexOf('--status-arquivo') + 1];
writeFileSync(statusPath + '.args', JSON.stringify(args));
const status = {
  estado: 'baixando', ufs: [], mes: null, iniciado_em: '', atualizado_em: '',
  etapa: 'Baixando', pid: process.pid,
};
writeFileSync(statusPath, JSON.stringify(status));
const timer = setInterval(() => {
  if (existsSync(statusPath + '.stop')) {
    clearInterval(timer);
    writeFileSync(statusPath, JSON.stringify({ ...status, estado: 'concluido' }));
  }
}, 20);
`;

let dir: string;
let cliPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'radar-job-'));
  cliPath = join(dir, 'fake-cli.mjs');
  await writeFile(cliPath, FAKE_CLI);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const statusOf = (status: Partial<DownloadStatus>) =>
  JSON.stringify({ estado: 'baixando', ufs: [], pid: process.pid, ...status });

describe('startDownload', () => {
  it('runs one process at a time and reports when it ends', async () => {
    const databasePath = join(dir, 'pasta-nova', 'um.duckdb');
    const statusPath = downloadStatusPath(databasePath);

    const first = await startDownload({
      databasePath,
      cliPath,
      states: ['SP', 'MG'],
      month: '2026-10',
    });
    expect(first.iniciado).toBe(true);

    await vi.waitFor(async () => {
      const args = JSON.parse(await readFile(`${statusPath}.args`, 'utf8'));
      expect(args).toEqual([
        'baixar',
        '--ufs',
        'SP,MG',
        '--mes',
        '2026-10',
        '--status-arquivo',
        statusPath,
      ]);
    });

    const second = await startDownload({ databasePath, cliPath, states: ['RJ'] });
    expect(second.iniciado).toBe(false);

    await writeFile(`${statusPath}.stop`, '');
    await vi.waitFor(async () => {
      expect((await readDownloadStatus(statusPath))?.estado).toBe('concluido');
    });
  });

  it('asks for the whole country when no state is given', async () => {
    const databasePath = join(dir, 'brasil.duckdb');
    const statusPath = downloadStatusPath(databasePath);
    await startDownload({ databasePath, cliPath, states: [] });
    await vi.waitFor(async () => {
      expect(await readFile(`${statusPath}.args`, 'utf8')).toContain('--todas');
    });
    await writeFile(`${statusPath}.stop`, '');
    await vi.waitFor(async () => {
      expect((await readDownloadStatus(statusPath))?.estado).toBe('concluido');
    });
  });
});

describe('readDownloadStatus', () => {
  it('returns null when nothing ran or the file is unreadable', async () => {
    expect(await readDownloadStatus(join(dir, 'nada.json'))).toBeNull();
    const broken = join(dir, 'quebrado.json');
    await writeFile(broken, '{');
    expect(await readDownloadStatus(broken)).toBeNull();
  });

  it('reports a download whose process died as interrupted', async () => {
    const path = join(dir, 'morto.json');
    await writeFile(path, statusOf({ pid: 2 ** 22 + 12345 }));
    expect((await readDownloadStatus(path))?.estado).toBe('interrompido');
  });

  it('keeps a running download as running', async () => {
    const path = join(dir, 'vivo.json');
    await writeFile(path, statusOf({}));
    expect((await readDownloadStatus(path))?.estado).toBe('baixando');
  });
});

describe('DownloadStatusWriter', () => {
  it('records the steps, the result and failures', async () => {
    const path = join(dir, 'escrita.json');
    const writer = new DownloadStatusWriter(path, ['SP'], undefined);
    writer.step('Baixado Cnaes.zip');
    await writer.finish({ estabelecimentos: 10, mes_referencia: '2026-10' });
    expect(await readDownloadStatus(path)).toMatchObject({
      estado: 'concluido',
      ufs: ['SP'],
      estabelecimentos: 10,
      mes_referencia: '2026-10',
    });

    await writer.fail(new Error('sem espaço'));
    expect(await readDownloadStatus(path)).toMatchObject({ estado: 'erro', erro: 'sem espaço' });
  });
});

describe('LazyRepositoryProvider', () => {
  it('starts using the new database once a download replaces the file', async () => {
    const sourceDir = await createDatasetFolder();
    const databasePath = join(dir, 'troca.duckdb');
    const provider = new LazyRepositoryProvider(databasePath);
    try {
      await importDataset({ sourceDir, databasePath, states: ['SP'], referenceMonth: '2026-09' });
      expect((await (await provider.get()).status()).mes_referencia).toBe('2026-09');

      await importDataset({ sourceDir, databasePath, states: ['SP'], referenceMonth: '2026-10' });
      expect((await (await provider.get()).status()).mes_referencia).toBe('2026-10');
    } finally {
      provider.close();
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});
