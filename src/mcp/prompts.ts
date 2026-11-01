import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RepositoryProvider } from '../data/provider.ts';

/** Registers ready-made workflows the user can invoke, e.g. as slash commands. */
export function registerPrompts(server: McpServer, provider: RepositoryProvider): void {
  const importedStates = async (value: string): Promise<string[]> => {
    try {
      const { ufs } = await (await provider.get()).status();
      return ufs.filter((uf) => uf.startsWith(value.toUpperCase()));
    } catch {
      return [];
    }
  };

  server.registerPrompt(
    'prospectar',
    {
      title: 'Prospectar empresas',
      description: 'Encontra e lista empresas de uma atividade numa região.',
      argsSchema: {
        atividade: z.string().describe('O que as empresas fazem, ex.: "oficina mecânica".'),
        regiao: z.string().describe('Cidades, bairros ou UF, ex.: "Campinas e Sumaré".'),
        criterios: z
          .string()
          .optional()
          .describe('Outros critérios, ex.: "sem MEI, abertas há mais de 2 anos".'),
      },
    },
    ({ atividade, regiao, criterios }) =>
      userMessage(`Quero prospectar empresas de "${atividade}" em ${regiao}.${
        criterios ? `\nCritérios adicionais: ${criterios}.` : ''
      }

Use as ferramentas do radar-cnpj:
1. Descubra os códigos CNAE da atividade com buscar_cnae. Se houver mais de um código plausível, use todos e diga quais escolheu.
2. Confirme os municípios da região com buscar_municipio quando houver dúvida.
3. Use contar_empresas agrupando por município para mostrar o tamanho do mercado.
4. Liste as empresas com buscar_empresas aplicando os critérios, numa tabela com nome, município, bairro, data de abertura e telefone.
5. Se houver mais resultados do que a lista mostra, ofereça exportar tudo com exportar_csv.`),
  );

  server.registerPrompt(
    'dimensionar_mercado',
    {
      title: 'Dimensionar mercado',
      description: 'Mostra quantas empresas de uma atividade existem e onde se concentram.',
      argsSchema: {
        atividade: z.string().describe('O que as empresas fazem.'),
        uf: completable(z.string().describe('Sigla da UF, ex.: SP.'), importedStates),
      },
    },
    ({ atividade, uf }) =>
      userMessage(`Quero entender o mercado de "${atividade}" em ${uf.toUpperCase()}.

Use as ferramentas do radar-cnpj:
1. Descubra os códigos CNAE da atividade com buscar_cnae.
2. Com contar_empresas, mostre o total de empresas ativas e as contagens agrupadas por município, por porte e por ano de abertura.
3. Resuma em poucos tópicos onde o mercado se concentra, a proporção de MEIs e se o número de aberturas está crescendo nos últimos anos.`),
  );

  server.registerPrompt(
    'empresas_novas',
    {
      title: 'Empresas recém-abertas',
      description: 'Lista empresas de uma atividade abertas recentemente numa região.',
      argsSchema: {
        atividade: z.string().describe('O que as empresas fazem.'),
        regiao: z.string().describe('Cidades, bairros ou UF.'),
        dias: z.string().optional().describe('Janela em dias. Padrão: 90.'),
      },
    },
    ({ atividade, regiao, dias }) => {
      const days = Number.parseInt(dias ?? '', 10) || 90;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return userMessage(`Liste as empresas de "${atividade}" em ${regiao} abertas a partir de ${since} (últimos ${days} dias).

Use as ferramentas do radar-cnpj:
1. Descubra os códigos CNAE da atividade com buscar_cnae.
2. Use buscar_empresas com aberta_apos = "${since}" e ordenar_por = "mais_recentes".
3. Mostre uma tabela com nome, município, bairro, data de abertura e telefone, e informe o total.
4. Lembre que a base reflete o mês de referência de status_base: aberturas mais recentes ainda não aparecem.`);
    },
  );
}

function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}
