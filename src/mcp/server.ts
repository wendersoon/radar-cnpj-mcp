import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RepositoryProvider } from '../data/provider.ts';
import { UFS } from '../domain/codes.ts';
import { countShape, filterShape, SORT_ORDERS, searchShape } from '../domain/filters.ts';

export interface ServerOptions {
  version: string;
  /** Folder where exportar_csv writes files. */
  exportDir: string;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const INSTRUCTIONS = `Busca empresas brasileiras na base pública de CNPJ da Receita Federal, importada localmente.

Fluxo recomendado:
1. Use buscar_cnae para transformar a atividade descrita pelo usuário em códigos CNAE.
2. Use buscar_municipio quando houver dúvida sobre o nome de uma cidade.
3. Use contar_empresas (com agrupar_por) para dimensionar o mercado antes de listar.
4. Use buscar_empresas para listar e exportar_csv para entregar listas grandes.

Por padrão só empresas ATIVAS são consideradas e os contatos de MEIs ficam ocultos (LGPD).
Os dados refletem o mês de referência informado por status_base.`;

const MAX_EXPORT_ROWS = 200_000;

/** Creates the MCP server exposing the company search tools. */
export function createServer(provider: RepositoryProvider, options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'radar-cnpj-mcp', version: options.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'buscar_empresas',
    {
      title: 'Buscar empresas',
      description:
        'Lista empresas (estabelecimentos) que atendem aos filtros, com CNPJ, razão social, atividade, endereço e contatos cadastrados na Receita. Retorna também o total de resultados para paginação.',
      inputSchema: searchShape,
      annotations: READ_ONLY,
    },
    (params) => run(async () => (await provider.get()).search(params)),
  );

  server.registerTool(
    'contar_empresas',
    {
      title: 'Contar empresas',
      description:
        'Conta as empresas que atendem aos filtros, opcionalmente agrupando por UF, município, bairro, CNAE, porte ou ano de abertura. Ideal para dimensionar um mercado.',
      inputSchema: countShape,
      annotations: READ_ONLY,
    },
    (params) => run(async () => (await provider.get()).count(params)),
  );

  server.registerTool(
    'buscar_cnae',
    {
      title: 'Buscar CNAE',
      description:
        'Encontra códigos CNAE pela descrição da atividade (ex.: "oficina mecânica", "odontologia") ou pelo início do código (ex.: "4520").',
      inputSchema: {
        termo: z.string().min(2).describe('Palavras da atividade ou início do código.'),
        limite: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY,
    },
    ({ termo, limite }) => run(async () => (await provider.get()).findCnae(termo, limite)),
  );

  server.registerTool(
    'buscar_municipio',
    {
      title: 'Buscar município',
      description:
        'Encontra municípios pelo nome (busca parcial, sem diferenciar acentos) entre as UFs importadas.',
      inputSchema: {
        nome: z.string().min(2),
        uf: z.enum(UFS).optional(),
        limite: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ_ONLY,
    },
    ({ nome, uf, limite }) =>
      run(async () => (await provider.get()).findMunicipality(nome, uf, limite)),
  );

  server.registerTool(
    'detalhar_empresa',
    {
      title: 'Detalhar empresa',
      description:
        'Mostra todos os dados de um estabelecimento pelo CNPJ, incluindo atividades secundárias.',
      inputSchema: {
        cnpj: z.string().min(14).describe('CNPJ com ou sem pontuação.'),
        incluir_contatos_mei: searchShape.incluir_contatos_mei,
      },
      annotations: READ_ONLY,
    },
    ({ cnpj, incluir_contatos_mei }) =>
      run(async () => {
        const company = await (await provider.get()).getCompany(cnpj, incluir_contatos_mei);
        if (!company) {
          throw new Error(`CNPJ ${cnpj} não encontrado nas UFs importadas.`);
        }
        return company;
      }),
  );

  server.registerTool(
    'exportar_csv',
    {
      title: 'Exportar CSV',
      description: `Grava as empresas que atendem aos filtros num arquivo CSV (separado por ";", pronto para Excel) na pasta ${options.exportDir} e retorna o caminho.`,
      inputSchema: {
        ...filterShape,
        ordenar_por: z.enum(SORT_ORDERS).default('mais_recentes'),
        incluir_contatos_mei: searchShape.incluir_contatos_mei,
        arquivo: z
          .string()
          .regex(/^[\w.-]+\.csv$/, 'Use apenas um nome de arquivo terminado em .csv, sem pastas.')
          .optional()
          .describe('Nome do arquivo. Padrão: leads-<data-hora>.csv'),
        maximo_linhas: z.number().int().min(1).max(MAX_EXPORT_ROWS).default(10_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ arquivo, maximo_linhas, ...params }) =>
      run(async () => {
        await mkdir(options.exportDir, { recursive: true });
        const name = arquivo ?? `leads-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        const path = join(options.exportDir, name);
        const linhas = await (await provider.get()).exportCsv(params, path, maximo_linhas);
        return { arquivo: path, linhas };
      }),
  );

  server.registerTool(
    'status_base',
    {
      title: 'Status da base',
      description:
        'Informa o mês de referência dos dados, as UFs importadas e o total de estabelecimentos.',
      annotations: READ_ONLY,
    },
    () => run(async () => (await provider.get()).status()),
  );

  return server;
}

/** Runs a tool body, reporting failures as tool errors the model can act on. */
async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await body();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
