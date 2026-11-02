import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Database, sqlLiteral } from './database.ts';

/**
 * Format of the monthly dataset published as GitHub Release assets: one
 * Parquet file per state plus lookup tables, metadata and checksums. The
 * `exportar-dados` command produces it and `baixar` consumes it, so both
 * sides share this module.
 */

export const DEFAULT_DATA_REPO = 'wendersoon/radar-cnpj-dados';
export const CHECKSUMS_FILE = 'SHA256SUMS';
export const METADATA_FILE = 'metadados.json';
export const CNAES_FILE = 'cnaes.parquet';
export const MUNICIPALITIES_FILE = 'municipios.parquet';

/** GitHub limits each release asset to 2 GiB; keep a safety margin. */
const MAX_ASSET_BYTES = 1.9 * 1024 ** 3;

export function establishmentsFile(uf: string): string {
  return `estabelecimentos-${uf}.parquet`;
}

/** Release tag of a reference month (AAAA-MM). */
export function releaseTag(month: string): string {
  return `dados-${month}`;
}

export interface ReleaseMetadata {
  mes_referencia: string | null;
  gerado_em: string;
  fonte: string;
  versao_esquema: string | null;
  tratamento_lgpd: string[];
  ufs: { uf: string | null; estabelecimentos: number; ativos: number }[];
}

/**
 * Published columns. MEI contacts are always left out, and the CPF that
 * Receita appends to sole proprietor names is removed again here as a second
 * line of defense, in case the database came from an older import.
 */
const COLUMNS = String.raw`
  cnpj, cnpj_basico, matriz,
  NULLIF(regexp_replace(nome_fantasia, '\s*\d{11}$', ''), '') AS nome_fantasia,
  situacao, data_situacao, data_abertura,
  cnae_principal, cnae_descricao, cnaes_secundarios,
  endereco, bairro, cep, uf, municipio_codigo, municipio,
  CASE WHEN mei THEN NULL ELSE ddd_1 END AS ddd_1,
  CASE WHEN mei THEN NULL ELSE telefone_1 END AS telefone_1,
  CASE WHEN mei THEN NULL ELSE ddd_2 END AS ddd_2,
  CASE WHEN mei THEN NULL ELSE telefone_2 END AS telefone_2,
  CASE WHEN mei THEN NULL ELSE email END AS email,
  NULLIF(regexp_replace(razao_social, '\s*\d{11}$', ''), '') AS razao_social,
  natureza_juridica, capital_social, porte, simples, mei`;

/**
 * Writes the release files for every state in the database into outDir.
 * One state at a time: the table is clustered by state, so each export reads
 * only that slice and keeps a single file open.
 */
export async function exportRelease(
  db: Database,
  outDir: string,
  log: (message: string) => void = () => {},
): Promise<{ files: number; bytes: number }> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const metadata = new Map(
    (
      await db.all<{ chave: string; valor: string | null }>('SELECT chave, valor FROM metadados')
    ).map((row) => [row.chave, row.valor]),
  );
  if (metadata.get('ufs')) {
    throw new Error(
      `A base contém só as UFs ${metadata.get('ufs')}; o release precisa da base completa.`,
    );
  }

  const states = await db.all<{ uf: string | null }>(
    'SELECT DISTINCT uf FROM estabelecimentos ORDER BY uf NULLS LAST',
  );
  for (const { uf } of states) {
    const name = establishmentsFile(uf ?? 'SEM-UF');
    log(`Exportando ${name}...`);
    await db.run(
      `COPY (SELECT ${COLUMNS} FROM estabelecimentos WHERE uf IS NOT DISTINCT FROM $1)
       TO ${sqlLiteral(join(outDir, name))} (FORMAT parquet, COMPRESSION zstd)`,
      [uf],
    );
  }

  log('Exportando CNAEs e municípios...');
  await db.run(
    `COPY (SELECT codigo, descricao FROM cnaes ORDER BY codigo)
     TO ${sqlLiteral(join(outDir, CNAES_FILE))} (FORMAT parquet, COMPRESSION zstd)`,
  );
  await db.run(
    `COPY (SELECT codigo, nome, uf FROM municipios ORDER BY uf, nome)
     TO ${sqlLiteral(join(outDir, MUNICIPALITIES_FILE))} (FORMAT parquet, COMPRESSION zstd)`,
  );

  const perState = await db.all<{ uf: string | null; estabelecimentos: number; ativos: number }>(
    `SELECT uf, count(*)::INTEGER AS estabelecimentos, count_if(situacao = '02')::INTEGER AS ativos
     FROM estabelecimentos GROUP BY uf ORDER BY uf`,
  );
  const releaseMetadata: ReleaseMetadata = {
    mes_referencia: metadata.get('mes_referencia') ?? null,
    gerado_em: new Date().toISOString(),
    fonte: 'Receita Federal do Brasil - Dados Abertos do CNPJ',
    versao_esquema: metadata.get('versao_esquema') ?? null,
    tratamento_lgpd: [
      'CPF removido do nome de empresários individuais',
      'telefone e e-mail de MEIs omitidos',
    ],
    ufs: perState,
  };
  await writeFile(join(outDir, METADATA_FILE), `${JSON.stringify(releaseMetadata, null, 2)}\n`);

  log('Calculando hashes...');
  const lines: string[] = [];
  let bytes = 0;
  for (const name of (await readdir(outDir)).sort()) {
    const { size } = await stat(join(outDir, name));
    if (size > MAX_ASSET_BYTES) {
      throw new Error(
        `${name} tem ${(size / 1024 ** 3).toFixed(2)} GB, acima do limite do GitHub.`,
      );
    }
    bytes += size;
    lines.push(`${await sha256File(join(outDir, name))}  ${name}`);
  }
  await writeFile(join(outDir, CHECKSUMS_FILE), `${lines.join('\n')}\n`);
  return { files: lines.length + 1, bytes };
}

/** Parses a `sha256sum`-style file into a map of file name to hash. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) {
      sums.set(match[2], match[1]);
    }
  }
  return sums;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
