import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RepositoryProvider } from '../data/provider.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerTools } from './tools.ts';

export interface ServerOptions {
  version: string;
  /** Folder where exportar_csv writes files. */
  exportDir: string;
  databasePath: string;
  /** Script of this CLI, run as a separate process by baixar_dados. */
  cliPath: string;
}

const INSTRUCTIONS = `Busca empresas brasileiras na base pública de CNPJ da Receita Federal, importada localmente.

Sem base importada, as ferramentas de consulta retornam erro: confirme com o usuário as UFs e o download de cerca de 7 GB, use baixar_dados e acompanhe com andamento_download.

Fluxo recomendado:
1. Use buscar_cnae para transformar a atividade descrita pelo usuário em códigos CNAE.
2. Use buscar_municipio quando houver dúvida sobre o nome de uma cidade.
3. Use contar_empresas (com agrupar_por) para ver os totais antes de listar.
4. Use buscar_empresas para listar e exportar_csv para entregar listas grandes.

Para visão geral de uma cidade, use perfil_municipio. Para comparar cidades ou UFs, use comparar_regioes.

Por padrão só empresas ATIVAS são consideradas. Telefone e e-mail de MEIs costumam ser os da própria pessoa física: use-os com cuidado (LGPD).
Os dados refletem o mês de referência informado por status_base.`;

/** Creates the MCP server with its tools, prompts and resources. */
export function createServer(provider: RepositoryProvider, options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: 'radar-cnpj-mcp', version: options.version },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, provider, options);
  registerPrompts(server, provider);
  registerResources(server, provider);
  return server;
}
