import { mkdtemp, readdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/data/database.ts';
import { DownloadError, downloadDataset } from '../src/data/downloader.ts';
import { importDataset } from '../src/data/importer.ts';
import { exportRelease } from '../src/data/release.ts';
import { CompanyRepository } from '../src/data/repository.ts';
import { searchSchema } from '../src/domain/filters.ts';
import { createDatasetFolder } from './fixtures.ts';

const REPO = 'tester/radar-cnpj-dados';

let workDir: string;
let releaseDir: string;
let server: Server;
let api: string;
/** Files served with altered content, to simulate a corrupted download. */
const corrupted = new Set<string>();

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'radar-download-'));
  const sourceDir = await createDatasetFolder();
  const fullDb = join(workDir, 'brasil.duckdb');
  await importDataset({ sourceDir, databasePath: fullDb, referenceMonth: '2026-10' });
  await rm(sourceDir, { recursive: true, force: true });

  releaseDir = join(workDir, 'release');
  const db = await Database.open(fullDb, { readOnly: true });
  await exportRelease(db, releaseDir);
  db.close();

  server = createServer(async (request, response) => {
    const url = request.url ?? '';
    const assets = async () =>
      (await readdir(releaseDir)).map((name) => ({
        name,
        size: 1,
        browser_download_url: `${api}/files/${name}`,
      }));

    if (
      url === `/repos/${REPO}/releases/latest` ||
      url === `/repos/${REPO}/releases/tags/dados-2026-10`
    ) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ tag_name: 'dados-2026-10', assets: await assets() }));
      return;
    }
    const file = /^\/files\/(.+)$/.exec(url)?.[1];
    if (file) {
      const content = await readFileAsync(join(releaseDir, file));
      response.end(corrupted.has(file) ? Buffer.concat([content, Buffer.from('x')]) : content);
      return;
    }
    response.statusCode = 404;
    response.end('{"message":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await rm(workDir, { recursive: true, force: true });
});

const download = (databasePath: string, states: string[], month?: string) =>
  downloadDataset({
    databasePath,
    states,
    repo: REPO,
    apiBaseUrl: api,
    ...(month ? { month } : {}),
  });

describe('exportRelease', () => {
  it('writes one file per state, lookup tables, metadata and checksums', async () => {
    expect((await readdir(releaseDir)).sort()).toEqual([
      'SHA256SUMS',
      'cnaes.parquet',
      'estabelecimentos-MG.parquet',
      'estabelecimentos-SP.parquet',
      'metadados.json',
      'municipios.parquet',
    ]);
    const metadata = JSON.parse(await readFileAsync(join(releaseDir, 'metadados.json'), 'utf8'));
    expect(metadata).toMatchObject({
      mes_referencia: '2026-10',
      ufs: [{ uf: 'MG' }, { uf: 'SP' }],
    });
  });

  it('refuses to publish a database with only some states', async () => {
    const sourceDir = await createDatasetFolder();
    const partial = join(workDir, 'parcial.duckdb');
    await importDataset({ sourceDir, databasePath: partial, states: ['SP'] });
    await rm(sourceDir, { recursive: true, force: true });
    const db = await Database.open(partial, { readOnly: true });
    try {
      await expect(exportRelease(db, join(workDir, 'parcial-release'))).rejects.toThrow(
        'base completa',
      );
    } finally {
      db.close();
    }
  });
});

describe('downloadDataset', () => {
  it('builds a searchable database with only the requested states', async () => {
    const path = join(workDir, 'sp.duckdb');
    const summary = await download(path, ['sp']);
    expect(summary).toMatchObject({ establishments: 5, states: ['SP'], referenceMonth: '2026-10' });

    const db = await Database.open(path, { readOnly: true });
    try {
      const repo = new CompanyRepository(db);
      expect(await repo.status()).toMatchObject({ ufs: ['SP'], mes_referencia: '2026-10' });

      const result = await repo.search(
        searchSchema.parse({ cnaes: ['4520'], municipios: ['campinas'] }),
      );
      expect(result.total).toBe(2);

      // Published data never carries MEI contacts nor the CPF in the name.
      const [mei] = (
        await repo.search(searchSchema.parse({ mei: 'somente', incluir_contatos_mei: true }))
      ).empresas;
      expect(mei).toMatchObject({ razao_social: 'JOAO DA SILVA', telefones: [], email: null });

      expect(await repo.findMunicipality('belo horizonte')).toEqual([]);
      expect((await repo.findCnae('funilaria')).map((c) => c.codigo)).toEqual(['4520-0/02']);
    } finally {
      db.close();
    }
    expect((await readdir(workDir)).filter((name) => name.startsWith('.radar-download-'))).toEqual(
      [],
    );
  });

  it('downloads a specific month', async () => {
    const summary = await download(join(workDir, 'mes.duckdb'), ['MG'], '2026-10');
    expect(summary).toMatchObject({ establishments: 1, states: ['MG'] });
  });

  it('explains unknown months and states', async () => {
    await expect(download(join(workDir, 'x.duckdb'), ['SP'], '1999-01')).rejects.toThrow(
      'Não há dados do mês 1999-01',
    );
    await expect(download(join(workDir, 'x.duckdb'), ['RR'])).rejects.toThrow(
      'UF RR não existe no release dados-2026-10. Disponíveis: MG, SP.',
    );
    await expect(download(join(workDir, 'x.duckdb'), [])).rejects.toThrow(DownloadError);
  });

  it('rejects corrupted files and keeps the current database', async () => {
    const path = join(workDir, 'atual.duckdb');
    await writeFile(path, 'base atual');
    corrupted.add('estabelecimentos-SP.parquet');
    try {
      await expect(download(path, ['SP'])).rejects.toThrow('veio corrompido');
    } finally {
      corrupted.clear();
    }
    expect(await readFileAsync(path, 'utf8')).toBe('base atual');
    expect((await readdir(workDir)).some((name) => name === 'atual.duckdb.importing')).toBe(false);
  });
});
