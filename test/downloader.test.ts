import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/data/database.ts';
import {
  DownloadError,
  downloadDataset,
  parseListing,
  parseShareUrl,
} from '../src/data/downloader.ts';
import { CompanyRepository } from '../src/data/repository.ts';
import { searchSchema } from '../src/domain/filters.ts';
import { createDatasetFolder } from './fixtures.ts';

const TOKEN = 'token123';
const ROOT = '/public.php/webdav/Dados/CNPJ';

let workDir: string;
let sourceDir: string;
let server: Server;
let shareUrl: string;
/** Requested file names, to prove only the needed ones are downloaded. */
let requested: string[];
/** How many times each file still fails or arrives truncated. */
let failures: Map<string, number>;
let truncated: Set<string>;

function listing(path: string, children: { name: string; size?: number }[]): string {
  const entry = (href: string, size?: number) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${
      size === undefined
        ? '<d:resourcetype><d:collection/></d:resourcetype>'
        : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength>`
    }</d:prop></d:propstat></d:response>`;
  const body = children
    .map(({ name, size }) => entry(`${path}${name}${size === undefined ? '/' : ''}`, size))
    .join('');
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entry(path)}${body}</d:multistatus>`;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'radar-download-'));
  sourceDir = await createDatasetFolder();

  server = createServer(async (request, response) => {
    const expected = `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`;
    if (request.headers.authorization !== expected) {
      response.statusCode = 401;
      response.end();
      return;
    }
    const url = request.url ?? '';
    if (request.method === 'PROPFIND') {
      response.statusCode = 207;
      if (url === `${ROOT}/`) {
        response.end(
          listing(url, [{ name: '2026-09' }, { name: '2026-10' }, { name: 'temporario' }]),
        );
        return;
      }
      if (url === `${ROOT}/2026-10/`) {
        const names = await readdir(sourceDir);
        const files = await Promise.all(
          names.map(async (name) => ({ name, size: (await stat(join(sourceDir, name))).size })),
        );
        response.end(listing(url, [...files, { name: 'Socios0.zip', size: 10 }]));
        return;
      }
      response.statusCode = 404;
      response.end();
      return;
    }
    const name = url.split('/').pop() ?? '';
    requested.push(name);
    const remaining = failures.get(name) ?? 0;
    if (remaining > 0) {
      failures.set(name, remaining - 1);
      response.statusCode = 503;
      response.end();
      return;
    }
    const content = await readFile(join(sourceDir, name));
    response.end(truncated.has(name) ? content.subarray(0, 10) : content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  shareUrl = `http://127.0.0.1:${port}/index.php/s/${TOKEN}?dir=/Dados/CNPJ`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await rm(workDir, { recursive: true, force: true });
  await rm(sourceDir, { recursive: true, force: true });
});

beforeEach(() => {
  requested = [];
  failures = new Map();
  truncated = new Set();
});

describe('parseShareUrl', () => {
  it('turns the browser link into the WebDAV endpoint', () => {
    const share = parseShareUrl('https://example.gov.br/index.php/s/abc?dir=/Dados/CNPJ/');
    expect(share.webdavUrl).toBe('https://example.gov.br/public.php/webdav/Dados/CNPJ');
    expect(share.authorization).toBe(`Basic ${Buffer.from('abc:').toString('base64')}`);
  });

  it.each(['nao-e-link', 'https://example.gov.br/s/abc', 'https://example.gov.br/x?dir=/a'])(
    'rejects %s',
    (url) => {
      expect(() => parseShareUrl(url)).toThrow(DownloadError);
    },
  );
});

describe('parseListing', () => {
  it('leaves out the listed folder and decodes names', () => {
    const xml = listing('/a/', [{ name: 'b%20c.zip', size: 5 }, { name: '2026-10' }]);
    expect(parseListing(xml)).toEqual([
      { name: 'b c.zip', size: 5, isDirectory: false },
      { name: '2026-10', size: 0, isDirectory: true },
    ]);
  });
});

describe('downloadDataset', () => {
  it('imports the latest month, downloading only the needed files', async () => {
    const dir = await mkdtemp(join(workDir, 'ok-'));
    const databasePath = join(dir, 'base.duckdb');
    const summary = await downloadDataset({ databasePath, states: ['SP'], shareUrl });

    expect(summary.referenceMonth).toBe('2026-10');
    expect(summary.states).toEqual(['SP']);
    expect(requested).not.toContain('Socios0.zip');
    expect(requested.sort()).toEqual((await readdir(sourceDir)).sort());
    // Nothing but the database stays behind.
    expect((await readdir(dir)).filter((name) => name.startsWith('.radar'))).toEqual([]);

    const db = await Database.open(databasePath, { readOnly: true });
    const { total, empresas } = await new CompanyRepository(db).search(searchSchema.parse({}));
    db.close();
    expect(total).toBeGreaterThan(0);
    expect(empresas.every((company) => company.uf === 'SP')).toBe(true);
  });

  it('retries a file that fails and one that arrives incomplete', async () => {
    failures.set('Cnaes.zip', 1);
    truncated.add('Simples.zip');
    const dir = await mkdtemp(join(workDir, 'retry-'));
    await expect(
      downloadDataset({ databasePath: join(dir, 'b.duckdb'), states: ['SP'], shareUrl }),
    ).rejects.toThrow(/Simples\.zip.*incompleto.*importar/s);
    expect(requested.filter((name) => name === 'Cnaes.zip').length).toBeLessThanOrEqual(2);
    expect(requested.filter((name) => name === 'Simples.zip')).toHaveLength(3);

    truncated.clear();
    failures.set('Cnaes.zip', 2);
    const summary = await downloadDataset({
      databasePath: join(dir, 'b.duckdb'),
      states: ['SP'],
      shareUrl,
    });
    expect(summary.referenceMonth).toBe('2026-10');
  });

  it('reuses complete files kept from a previous run', async () => {
    const dir = await mkdtemp(join(workDir, 'keep-'));
    const options = {
      databasePath: join(dir, 'b.duckdb'),
      states: ['SP'],
      shareUrl,
      keepDir: join(dir, 'zips'),
    };
    const first = await downloadDataset(options);
    expect(first.downloadedBytes).toBeGreaterThan(0);
    expect(await readdir(join(dir, 'zips', '2026-10'))).toContain('Cnaes.zip');

    requested = [];
    const second = await downloadDataset(options);
    expect(requested).toEqual([]);
    expect(second.downloadedBytes).toBe(0);
  });

  it('reports a month that does not exist, pointing to the manual steps', async () => {
    const dir = await mkdtemp(join(workDir, 'mes-'));
    await expect(
      downloadDataset({
        databasePath: join(dir, 'b.duckdb'),
        states: [],
        month: '2020-01',
        shareUrl,
      }),
    ).rejects.toThrow(/2020-01.*importar/s);
  });

  it('reports when the share refuses access', async () => {
    const dir = await mkdtemp(join(workDir, 'auth-'));
    await expect(
      downloadDataset({
        databasePath: join(dir, 'b.duckdb'),
        states: [],
        shareUrl: shareUrl.replace(TOKEN, 'outro'),
      }),
    ).rejects.toThrow(/HTTP 401.*RADAR_CNPJ_RECEITA_URL/s);
  });
});
