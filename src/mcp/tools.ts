import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { downloadStatusPath, readDownloadStatus, startDownload } from '../data/download-job.ts';
import type { RepositoryProvider } from '../data/provider.ts';
import { UFS } from '../domain/codes.ts';
import { countShape, filterShape, SORT_ORDERS, searchShape } from '../domain/filters.ts';
import type { ServerOptions } from './server.ts';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const MAX_EXPORT_ROWS = 200_000;

/** Registers the company search tools. */
export function registerTools(
  server: McpServer,
  provider: RepositoryProvider,
  options: Pick<ServerOptions, 'exportDir' | 'databasePath' | 'cliPath'>,
): void {
  server.registerTool(
    'buscar_empresas',
    {
      title: 'Buscar empresas',
      description:
        'Lista empresas (estabelecimentos) que atendem aos filtros, com CNPJ, razão social, atividade, endereço e contatos cadastrados na Receita. O campo total é a contagem exata de todas as empresas que atendem aos filtros, sem amostragem nem teto; limite e deslocamento só controlam quais delas vêm na lista.',
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
        'Conta as empresas que atendem aos filtros, opcionalmente agrupando por UF, município, bairro, CNAE, porte, MEI ou ano de abertura. As contagens são exatas sobre toda a base importada, sem amostragem nem teto (números redondos são coincidência); maximo_grupos só limita quantos grupos são listados. Ideal para ver totais e distribuições.',
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
        ocultar_contatos_mei: searchShape.ocultar_contatos_mei,
      },
      annotations: READ_ONLY,
    },
    ({ cnpj, ocultar_contatos_mei }) =>
      run(async () => {
        const company = await (await provider.get()).getCompany(cnpj, ocultar_contatos_mei);
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
        ocultar_contatos_mei: searchShape.ocultar_contatos_mei,
        arquivo: z
          .string()
          .regex(/^[\w.-]+\.csv$/, 'Use apenas um nome de arquivo terminado em .csv, sem pastas.')
          .optional()
          .describe('Nome do arquivo. Padrão: empresas-<data-hora>.csv'),
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
        const name = arquivo ?? `empresas-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
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

  server.registerTool(
    'perfil_municipio',
    {
      title: 'Perfil do município',
      description:
        'Resume a economia de um município em uma chamada: empresas ativas, principais setores, porte, percentual de MEIs, situação cadastral e aberturas dos últimos 12 meses completos comparadas aos 12 anteriores. Retorna só totais, sem listar empresas.',
      inputSchema: {
        municipio: z.string().min(2).describe('Nome do município, sem diferenciar acentos.'),
        uf: z.enum(UFS).optional().describe('UF do município. Necessária em caso de homônimos.'),
        principais_setores: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Quantos setores (CNAE principal) listar.'),
      },
      annotations: READ_ONLY,
    },
    ({ municipio, uf, principais_setores }) =>
      run(async () =>
        (await provider.get()).analytics.municipalityProfile(municipio, uf, principais_setores),
      ),
  );

  server.registerTool(
    'baixar_dados',
    {
      title: 'Baixar dados da Receita',
      description:
        'Baixa os arquivos da Receita Federal e monta a base local, em segundo plano. São cerca de 7 GB de download, mesmo para uma só UF, e são necessários cerca de 20 GB livres durante o processo, que costuma levar mais de meia hora. SUBSTITUI a base atual quando termina: informe todas as UFs desejadas, inclusive as já importadas. Só use depois que o usuário confirmar as UFs e o download. Acompanhe com andamento_download; a base atual continua disponível até o fim.',
      inputSchema: {
        ufs: z
          .array(z.enum(UFS))
          .min(1)
          .optional()
          .describe('UFs a importar. Informe ufs ou todas.'),
        todas: z.boolean().default(false).describe('Importar o Brasil inteiro.'),
        mes: z
          .string()
          .regex(/^\d{4}-\d{2}$/, 'Use o formato AAAA-MM.')
          .optional()
          .describe('Mês de referência (AAAA-MM). Padrão: o mais recente.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ ufs, todas, mes }) =>
      run(async () => {
        if (todas === Boolean(ufs)) {
          throw new Error('Informe ufs ou todas: true, apenas um dos dois.');
        }
        const { iniciado, status } = await startDownload({
          databasePath: options.databasePath,
          cliPath: options.cliPath,
          states: ufs ?? [],
          month: mes,
        });
        return {
          iniciado,
          mensagem: iniciado
            ? 'Download iniciado em segundo plano. Consulte andamento_download.'
            : 'Já existe um download em andamento; nenhum outro foi iniciado.',
          ...status,
        };
      }),
  );

  server.registerTool(
    'andamento_download',
    {
      title: 'Andamento do download',
      description:
        'Informa o estado do último download iniciado (baixando, concluido, erro ou interrompido) e a etapa atual.',
      annotations: READ_ONLY,
    },
    () =>
      run(async () => {
        const path = downloadStatusPath(options.databasePath);
        return (await readDownloadStatus(path)) ?? { estado: 'nenhum' };
      }),
  );
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
