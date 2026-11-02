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
  const server = createServer(provider, {
    version: 'test',
    exportDir: join(workDir, 'exports'),
    databasePath,
    cliPath: join(workDir, 'cli-inexistente.js'),
  });
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
  it('exposes read-only search tools, a non-destructive export and a download', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      'andamento_download',
      'baixar_dados',
      'buscar_cnae',
      'buscar_empresas',
      'buscar_municipio',
      'comparar_regioes',
      'contar_empresas',
      'detalhar_empresa',
      'exportar_csv',
      'perfil_municipio',
      'status_base',
      'tendencia_setor',
    ]);
    expect(byName.buscar_empresas?.annotations?.readOnlyHint).toBe(true);
    expect(byName.andamento_download?.annotations?.readOnlyHint).toBe(true);
    expect(byName.baixar_dados?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
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

  it.each([
    ['neither ufs nor todas', {}],
    ['both ufs and todas', { ufs: ['SP'], todas: true }],
    ['an invalid state', { ufs: ['XX'] }],
    ['an invalid month', { ufs: ['SP'], mes: '10/2026' }],
  ])('refuses a download with %s', async (_, args) => {
    const result = await call('baixar_dados', args);
    expect(result.isError).toBe(true);
    expect(json(await call('andamento_download'))).toEqual({ estado: 'nenhum' });
  });

  it('explains how to import when the database is missing', async () => {
    const empty = await connect(join(workDir, 'missing.duckdb'));
    try {
      const result = await empty.client.callTool({ name: 'status_base', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('radar-cnpj-mcp baixar');
    } finally {
      await empty.client.close();
    }
  });
});

describe('MCP prompts', () => {
  it('lists the ready-made workflows', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'consultar_empresas',
      'empresas_recentes',
      'panorama_setor',
    ]);
  });

  it('builds a company query from the arguments', async () => {
    const { messages } = await client.getPrompt({
      name: 'consultar_empresas',
      arguments: { atividade: 'oficina mecânica', regiao: 'Campinas', criterios: 'sem MEI' },
    });
    const [message] = messages;
    expect(message?.role).toBe('user');
    expect(message?.content).toMatchObject({ type: 'text' });
    const text = message?.content.type === 'text' ? message.content.text : '';
    expect(text).toContain('"oficina mecânica" em Campinas');
    expect(text).toContain('Critérios adicionais: sem MEI');
    expect(text).toContain('buscar_cnae');
  });

  it('computes the start date of recent openings', async () => {
    const { messages } = await client.getPrompt({
      name: 'empresas_recentes',
      arguments: { atividade: 'academia', regiao: 'SP', dias: '30' },
    });
    const text = messages[0]?.content.type === 'text' ? messages[0].content.text : '';
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(text).toContain(`aberta_apos = "${since}"`);
  });

  it('completes states with the imported ones', async () => {
    const { completion } = await client.complete({
      ref: { type: 'ref/prompt', name: 'panorama_setor' },
      argument: { name: 'uf', value: 's' },
    });
    expect(completion.values).toEqual(['SP']);
  });
});

describe('MCP resources', () => {
  const read = async (uri: string) => {
    const { contents } = await client.readResource({ uri });
    const [content] = contents;
    return content && 'text' in content ? JSON.parse(content.text) : undefined;
  };

  it('lists static resources and templates', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      'radar://status',
      'radar://cnaes',
      'radar://municipios/SP',
    ]);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'radar://empresa/{cnpj}',
      'radar://municipios/{uf}',
    ]);
  });

  it('reads the dataset status and the CNAE table', async () => {
    expect(await read('radar://status')).toMatchObject({ ufs: ['SP'], estabelecimentos: 5 });
    expect(await read('radar://cnaes')).toHaveLength(4);
  });

  it('reads municipalities of a state', async () => {
    expect((await read('radar://municipios/SP')).map((m: { nome: string }) => m.nome)).toEqual([
      'CAMPINAS',
      'SAO PAULO',
      'SUMARE',
    ]);
  });

  it('reads a company by CNPJ', async () => {
    expect(await read('radar://empresa/11111111000191')).toMatchObject({
      razao_social: 'OFICINA DO JOAO LTDA',
    });
    await expect(client.readResource({ uri: 'radar://empresa/00000000000000' })).rejects.toThrow(
      'não encontrado',
    );
  });
});
