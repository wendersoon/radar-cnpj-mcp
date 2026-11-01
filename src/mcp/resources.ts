import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { RepositoryProvider } from '../data/provider.ts';
import { formatCnpj } from '../domain/format.ts';

const JSON_MIME = 'application/json';

/** Registers reference data the user or client can attach to a conversation. */
export function registerResources(server: McpServer, provider: RepositoryProvider): void {
  const importedStates = async (): Promise<string[]> => {
    try {
      return (await (await provider.get()).status()).ufs;
    } catch {
      return [];
    }
  };

  server.registerResource(
    'status',
    'radar://status',
    {
      title: 'Status da base',
      description: 'Mês de referência, UFs importadas e total de estabelecimentos.',
      mimeType: JSON_MIME,
    },
    async (uri) => json(uri, await (await provider.get()).status()),
  );

  server.registerResource(
    'cnaes',
    'radar://cnaes',
    {
      title: 'Tabela CNAE',
      description: 'Todos os códigos CNAE com suas descrições.',
      mimeType: JSON_MIME,
    },
    async (uri) => json(uri, await (await provider.get()).listCnaes()),
  );

  server.registerResource(
    'municipios',
    new ResourceTemplate('radar://municipios/{uf}', {
      list: async () => ({
        resources: (await importedStates()).map((uf) => ({
          uri: `radar://municipios/${uf}`,
          name: `Municípios de ${uf}`,
          mimeType: JSON_MIME,
        })),
      }),
      complete: {
        uf: async (value) =>
          (await importedStates()).filter((uf) => uf.startsWith(value.toUpperCase())),
      },
    }),
    {
      title: 'Municípios de uma UF',
      description: 'Municípios com empresas importadas numa UF.',
      mimeType: JSON_MIME,
    },
    async (uri, { uf }) =>
      json(uri, await (await provider.get()).listMunicipalities(String(uf).toUpperCase())),
  );

  server.registerResource(
    'empresa',
    new ResourceTemplate('radar://empresa/{cnpj}', { list: undefined }),
    {
      title: 'Empresa',
      description: 'Todos os dados de um estabelecimento pelo CNPJ (somente dígitos).',
      mimeType: JSON_MIME,
    },
    async (uri, { cnpj }) => {
      const company = await (await provider.get()).getCompany(String(cnpj));
      if (!company) {
        throw new Error(`CNPJ ${formatCnpj(String(cnpj))} não encontrado nas UFs importadas.`);
      }
      return json(uri, company);
    },
  );
}

function json(uri: URL, data: unknown): ReadResourceResult {
  return {
    contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(data, null, 2) }],
  };
}
