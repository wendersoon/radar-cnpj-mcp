#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ZodError } from 'zod';
import { defaultDatabasePath, defaultExportDir } from './config.ts';
import { importDataset } from './data/importer.ts';
import { LazyRepositoryProvider } from './data/provider.ts';
import type { Company } from './data/repository.ts';
import { searchSchema } from './domain/filters.ts';
import { createServer } from './mcp/server.ts';

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const HELP = `radar-cnpj-mcp ${VERSION}
Encontre empresas por CNAE e região na base pública de CNPJ da Receita Federal.

Uso:
  radar-cnpj-mcp                         inicia o servidor MCP (stdio)
  radar-cnpj-mcp importar <pasta>        importa os ZIPs do mês baixados da Receita
      --ufs SP,MG                        importa só estas UFs (recomendado)
      --mes 2026-10                      mês de referência (padrão: nome da pasta)
  radar-cnpj-mcp buscar [filtros]        lista empresas no terminal
      --cnae 4520-0/01   --uf SP   --municipio Campinas   --bairro Centro
      --aberta-apos 2025-01-01   --sem-mei   --limite 20   --json
      --csv leads.csv                    grava o resultado num CSV
  radar-cnpj-mcp status                  mostra o mês e as UFs importadas

Variáveis de ambiente:
  RADAR_CNPJ_DB          caminho do banco (padrão: ${defaultDatabasePath()})
  RADAR_CNPJ_EXPORT_DIR  pasta dos CSVs exportados via MCP (padrão: ${defaultExportDir()})
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const databasePath = defaultDatabasePath();

  switch (command) {
    case undefined:
      if (process.stdin.isTTY) {
        // A person ran it in a terminal: an MCP client would pipe stdin instead.
        console.log(HELP);
        return;
      }
      return serveMcp(databasePath);
    case 'mcp':
      return serveMcp(databasePath);
    case 'importar':
      return runImport(args, databasePath);
    case 'buscar':
      return runSearch(args, databasePath);
    case 'status':
      return runStatus(databasePath);
    case '-v':
    case '--version':
      console.log(VERSION);
      return;
    case '-h':
    case '--help':
    case 'ajuda':
      console.log(HELP);
      return;
    default:
      throw new UsageError(`Comando desconhecido: ${command}`);
  }
}

async function serveMcp(databasePath: string): Promise<void> {
  const provider = new LazyRepositoryProvider(databasePath);
  const server = createServer(provider, { version: VERSION, exportDir: defaultExportDir() });
  const shutdown = async () => {
    await server.close();
    provider.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr only.
  console.error(`radar-cnpj-mcp ${VERSION} pronto (base: ${databasePath})`);
}

async function runImport(args: string[], databasePath: string): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ufs: { type: 'string' }, mes: { type: 'string' } },
  });
  const [sourceDir] = positionals;
  if (!sourceDir) {
    throw new UsageError('Informe a pasta com os ZIPs: radar-cnpj-mcp importar <pasta> --ufs SP');
  }
  if (values.mes && !/^\d{4}-\d{2}$/.test(values.mes)) {
    throw new UsageError('Use --mes no formato AAAA-MM');
  }

  const started = Date.now();
  const summary = await importDataset({
    sourceDir: resolve(sourceDir),
    databasePath,
    states: values.ufs?.split(',').filter(Boolean) ?? [],
    ...(values.mes ? { referenceMonth: values.mes } : {}),
    log: (message) => console.error(message),
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const states = summary.states.length > 0 ? summary.states.join(', ') : 'todas';
  console.log(
    `${summary.establishments.toLocaleString('pt-BR')} estabelecimentos importados ` +
      `(UFs: ${states}; mês: ${summary.referenceMonth ?? 'não informado'}) em ${seconds}s.\n` +
      `Base: ${summary.databasePath}`,
  );
}

async function runSearch(args: string[], databasePath: string): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cnae: { type: 'string', multiple: true },
      uf: { type: 'string', multiple: true },
      municipio: { type: 'string', multiple: true },
      bairro: { type: 'string', multiple: true },
      'aberta-apos': { type: 'string' },
      'sem-mei': { type: 'boolean' },
      limite: { type: 'string', default: '20' },
      json: { type: 'boolean' },
      csv: { type: 'string' },
    },
  });

  const params = searchSchema.parse({
    cnaes: values.cnae,
    ufs: values.uf?.map((uf) => uf.toUpperCase()),
    municipios: values.municipio,
    bairros: values.bairro,
    aberta_apos: values['aberta-apos'],
    mei: values['sem-mei'] ? 'excluir' : 'incluir',
    limite: Number(values.limite),
  });

  const provider = new LazyRepositoryProvider(databasePath);
  try {
    const repository = await provider.get();
    if (values.csv) {
      const rows = await repository.exportCsv(params, resolve(values.csv), params.limite);
      console.log(`${rows} empresas gravadas em ${resolve(values.csv)}`);
      return;
    }

    const result = await repository.search(params);
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printTable(result.empresas);
    console.log(`\n${result.empresas.length} de ${result.total.toLocaleString('pt-BR')} empresas.`);
  } finally {
    provider.close();
  }
}

async function runStatus(databasePath: string): Promise<void> {
  const provider = new LazyRepositoryProvider(databasePath);
  try {
    const status = await (await provider.get()).status();
    console.log(
      [
        `Base:              ${databasePath}`,
        `Mês de referência: ${status.mes_referencia ?? 'não informado'}`,
        `UFs:               ${status.ufs.length > 0 ? status.ufs.join(', ') : 'todas'}`,
        `Estabelecimentos:  ${status.estabelecimentos.toLocaleString('pt-BR')}`,
        `Importado em:      ${status.importado_em ?? '-'}`,
      ].join('\n'),
    );
  } finally {
    provider.close();
  }
}

function printTable(companies: Company[]): void {
  const rows = companies.map((c) => [
    c.cnpj,
    truncate(c.nome_fantasia ?? c.razao_social ?? '', 40),
    `${c.municipio ?? ''}/${c.uf ?? ''}`,
    c.data_abertura ?? '',
    c.telefones[0] ?? '',
  ]);
  const header = ['CNPJ', 'NOME', 'MUNICÍPIO', 'ABERTURA', 'TELEFONE'];
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  for (const row of [header, ...rows]) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '));
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ZodError) {
    console.error(`Parâmetro inválido: ${error.issues.map((issue) => issue.message).join('; ')}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  if (error instanceof UsageError) {
    console.error('Use --help para ver os comandos.');
  }
  process.exit(1);
});
