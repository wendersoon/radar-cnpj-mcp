import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importDataset } from '../src/data/importer.ts';
import { LazyRepositoryProvider } from '../src/data/provider.ts';
import { createServer } from '../src/mcp/server.ts';
import { createDatasetFolder } from './fixtures.ts';

let sourceDir: string;
let workDir: string;
let provider: LazyRepositoryProvider;
let client: Client;

async function connect(
  databasePath: string,
): Promise<{ client: Client; provider: LazyRepositoryProvider }> {
  const provider = new LazyRepositoryProvider(databasePath);
  const server = createServer(provider, { version: 'test', exportDir: join(workDir, 'exports') });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, provider };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function json(result: CallToolResult): unknown {
  const [content] = result.content;
  return content?.type === 'text' ? JSON.parse(content.text) : undefined;
}

beforeAll(async () => {
  sourceDir = await createDatasetFolder();
  workDir = await mkdtemp(join(tmpdir(), 'radar-mcp-'));
  const databasePath = join(workDir, 'radar.duckdb');
  await importDataset({ sourceDir, databasePath, states: ['SP'] });
  ({ client, provider } = await connect(databasePath));
});

afterAll(async () => {
  await client?.close();
  provider?.close();
  await rm(sourceDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes read-only search tools and a non-destructive export', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      'buscar_cnae',
      'buscar_empresas',
      'buscar_municipio',
      'contar_empresas',
      'detalhar_empresa',
      'exportar_csv',
      'status_base',
    ]);
    expect(byName.buscar_empresas?.annotations?.readOnlyHint).toBe(true);
    expect(byName.exportar_csv?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('searches companies', async () => {
    const result = await call('buscar_empresas', { cnaes: ['4520'], municipios: ['Campinas'] });
    expect(result.isError).toBeFalsy();
    expect(json(result)).toMatchObject({ total: 2 });
  });

  it('resolves activities to CNAE codes', async () => {
    const result = await call('buscar_cnae', { termo: 'funilaria' });
    expect(json(result)).toEqual([
      {
        codigo: '4520-0/02',
        descricao: 'Serviços de lanternagem ou funilaria e pintura de veículos automotores',
      },
    ]);
  });

  it('reports invalid input and unknown companies as tool errors', async () => {
    expect((await call('buscar_empresas', { ufs: ['XX'] })).isError).toBe(true);
    const missing = await call('detalhar_empresa', { cnpj: '00.000.000/0000-00' });
    expect(missing.isError).toBe(true);
  });

  it('exports only inside the export folder', async () => {
    const result = await call('exportar_csv', { cnaes: ['4520'], arquivo: 'oficinas.csv' });
    const { arquivo, linhas } = json(result) as { arquivo: string; linhas: number };
    expect(arquivo).toBe(join(workDir, 'exports', 'oficinas.csv'));
    expect(linhas).toBe(3);
    expect(await readFile(arquivo, 'utf8')).toContain('OFICINA DO JOAO LTDA');

    const pathTraversal = await call('exportar_csv', { arquivo: '../../etc/evil.csv' });
    expect(pathTraversal.isError).toBe(true);
  });

  it('explains how to import when the database is missing', async () => {
    const empty = await connect(join(workDir, 'missing.duckdb'));
    try {
      const result = await empty.client.callTool({ name: 'status_base', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('radar-cnpj-mcp importar');
    } finally {
      await empty.client.close();
    }
  });
});
