import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { sizeLabel, statusLabel } from '../domain/codes.ts';
import type { CountParams, Filters, SearchParams } from '../domain/filters.ts';
import {
  formatCnae,
  formatCnpj,
  formatPhone,
  normalizeCnpj,
  normalizeText,
} from '../domain/format.ts';
import type { Database, SqlParam } from './database.ts';
import { buildWhere, escapeLike, GROUP_EXPRESSIONS, ORDER_BY } from './query.ts';

export interface Company {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  matriz: boolean;
  situacao: string | null;
  data_abertura: string | null;
  cnae_principal: { codigo: string; descricao: string | null };
  porte: string | null;
  mei: boolean;
  simples: boolean;
  capital_social: number | null;
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  municipio: string | null;
  uf: string | null;
  telefones: string[];
  email: string | null;
  /** True when the contacts of a MEI were withheld. */
  contatos_ocultos?: true;
}

export interface CompanyDetail extends Company {
  data_situacao: string | null;
  natureza_juridica: string | null;
  cnaes_secundarios: { codigo: string; descricao: string | null }[];
}

export interface SearchResult {
  total: number;
  limite: number;
  deslocamento: number;
  empresas: Company[];
}

export interface CountResult {
  total: number;
  grupos?: { grupo: string | null; quantidade: number }[];
}

export interface DatasetStatus {
  mes_referencia: string | null;
  ufs: string[];
  importado_em: string | null;
  estabelecimentos: number;
}

interface CompanyRow {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  matriz: boolean;
  situacao: string | null;
  data_situacao: string | null;
  data_abertura: string | null;
  cnae_principal: string;
  cnae_descricao: string | null;
  cnaes_secundarios: string[];
  natureza_juridica: string | null;
  porte: string | null;
  mei: boolean;
  simples: boolean;
  capital_social: number | null;
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
  municipio: string | null;
  uf: string | null;
  ddd_1: string | null;
  telefone_1: string | null;
  ddd_2: string | null;
  telefone_2: string | null;
  email: string | null;
}

export type ExportParams = Filters & Pick<SearchParams, 'ordenar_por' | 'incluir_contatos_mei'>;

const EXPORT_PAGE_SIZE = 5_000;

const CSV_COLUMNS = [
  'cnpj',
  'razao_social',
  'nome_fantasia',
  'matriz',
  'situacao',
  'data_abertura',
  'cnae_principal',
  'cnae_descricao',
  'porte',
  'mei',
  'simples',
  'capital_social',
  'endereco',
  'bairro',
  'cep',
  'municipio',
  'uf',
  'telefone_1',
  'telefone_2',
  'email',
] as const;

/** Read access to the imported company data. */
export class CompanyRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const where = buildWhere(params);
    const total = await this.countWhere(where.sql, where.params);
    const rows = await this.page(
      where.sql,
      where.params,
      params.ordenar_por,
      params.limite,
      params.deslocamento,
    );

    return {
      total,
      limite: params.limite,
      deslocamento: params.deslocamento,
      empresas: rows.map((row) => toCompany(row, params.incluir_contatos_mei)),
    };
  }

  async count(params: CountParams): Promise<CountResult> {
    const where = buildWhere(params);
    const total = await this.countWhere(where.sql, where.params);
    if (!params.agrupar_por) {
      return { total };
    }

    const expression = GROUP_EXPRESSIONS[params.agrupar_por];
    const limit = `$${where.params.length + 1}`;
    const rows = await this.db.all<{ grupo: string | null; quantidade: number }>(
      `SELECT ${expression} AS grupo, count(*)::INTEGER AS quantidade
       FROM estabelecimentos ${where.sql}
       GROUP BY grupo ORDER BY quantidade DESC, grupo LIMIT ${limit}`,
      [...where.params, params.maximo_grupos],
    );

    const grupos =
      params.agrupar_por === 'porte'
        ? rows.map((row) => ({ ...row, grupo: sizeLabel(row.grupo) }))
        : rows;
    return { total, grupos };
  }

  async findCnae(term: string, limit = 20): Promise<{ codigo: string; descricao: string }[]> {
    const digits = term.replace(/\D/g, '');
    const looksLikeCode = digits.length >= 2 && /^[\d\s./-]+$/.test(term.trim());

    const rows = looksLikeCode
      ? await this.db.all<{ codigo: string; descricao: string }>(
          'SELECT codigo, descricao FROM cnaes WHERE starts_with(codigo, $1) ORDER BY codigo LIMIT $2',
          [digits, limit],
        )
      : await this.findCnaeByWords(term, limit);

    return rows.map((row) => ({ codigo: formatCnae(row.codigo), descricao: row.descricao }));
  }

  async findMunicipality(
    name: string,
    uf?: string,
    limit = 20,
  ): Promise<{ codigo: string; nome: string; uf: string }[]> {
    const normalized = normalizeText(name);
    const params: SqlParam[] = [`%${escapeLike(normalized)}%`, normalized, limit];
    const ufFilter = uf ? 'AND uf = $4' : '';
    if (uf) {
      params.push(uf.toUpperCase());
    }
    // Exact matches first, so "São Paulo" comes before "São Paulo do Potengi".
    return this.db.all(
      `SELECT codigo, nome, uf FROM municipios
       WHERE nome_norm LIKE $1 ESCAPE '\\' ${ufFilter}
       ORDER BY nome_norm = $2 DESC, nome, uf
       LIMIT $3`,
      params,
    );
  }

  async getCompany(cnpj: string, includeMeiContacts = false): Promise<CompanyDetail | null> {
    const [row] = await this.db.all<CompanyRow>('SELECT * FROM estabelecimentos WHERE cnpj = $1', [
      normalizeCnpj(cnpj),
    ]);
    if (!row) {
      return null;
    }

    const secondary =
      row.cnaes_secundarios.length > 0
        ? await this.db.all<{ codigo: string; descricao: string | null }>(
            `SELECT codigo, descricao FROM cnaes
             WHERE codigo IN (${row.cnaes_secundarios.map((_, i) => `$${i + 1}`).join(', ')})
             ORDER BY codigo`,
            row.cnaes_secundarios,
          )
        : [];

    return {
      ...toCompany(row, includeMeiContacts),
      data_situacao: row.data_situacao,
      natureza_juridica: row.natureza_juridica,
      cnaes_secundarios: secondary.map((cnae) => ({
        codigo: formatCnae(cnae.codigo),
        descricao: cnae.descricao,
      })),
    };
  }

  async listCnaes(): Promise<{ codigo: string; descricao: string }[]> {
    const rows = await this.db.all<{ codigo: string; descricao: string }>(
      'SELECT codigo, descricao FROM cnaes ORDER BY codigo',
    );
    return rows.map((row) => ({ codigo: formatCnae(row.codigo), descricao: row.descricao }));
  }

  listMunicipalities(uf: string): Promise<{ codigo: string; nome: string; uf: string }[]> {
    return this.db.all('SELECT codigo, nome, uf FROM municipios WHERE uf = $1 ORDER BY nome', [uf]);
  }

  /** Writes matching companies to a CSV file readable by spreadsheets in pt-BR. */
  async exportCsv(params: ExportParams, path: string, maxRows: number): Promise<number> {
    const where = buildWhere(params);
    const out = createWriteStream(path, { encoding: 'utf8' });
    // BOM + semicolons: what Excel and LibreOffice expect in Brazilian locales.
    out.write(`﻿${CSV_COLUMNS.join(';')}\r\n`);

    let written = 0;
    while (written < maxRows) {
      const size = Math.min(EXPORT_PAGE_SIZE, maxRows - written);
      const rows = await this.page(where.sql, where.params, params.ordenar_por, size, written);
      for (const row of rows) {
        if (!out.write(`${toCsvLine(toCompany(row, params.incluir_contatos_mei))}\r\n`)) {
          await once(out, 'drain');
        }
      }
      written += rows.length;
      if (rows.length < size) {
        break;
      }
    }

    out.end();
    await once(out, 'finish');
    return written;
  }

  async status(): Promise<DatasetStatus> {
    const metadata = new Map(
      (
        await this.db.all<{ chave: string; valor: string | null }>(
          'SELECT chave, valor FROM metadados',
        )
      ).map((row) => [row.chave, row.valor]),
    );
    return {
      mes_referencia: metadata.get('mes_referencia') ?? null,
      ufs: metadata.get('ufs')?.split(',').filter(Boolean) ?? [],
      importado_em: metadata.get('importado_em') ?? null,
      estabelecimentos: await this.countWhere('', []),
    };
  }

  private async countWhere(where: string, params: SqlParam[]): Promise<number> {
    const [row] = await this.db.all<{ total: number }>(
      `SELECT count(*)::INTEGER AS total FROM estabelecimentos ${where}`,
      params,
    );
    return row?.total ?? 0;
  }

  private page(
    where: string,
    params: SqlParam[],
    order: SearchParams['ordenar_por'],
    limit: number,
    offset: number,
  ): Promise<CompanyRow[]> {
    const n = params.length;
    return this.db.all<CompanyRow>(
      `SELECT * FROM estabelecimentos ${where}
       ORDER BY ${ORDER_BY[order]} LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, offset],
    );
  }

  private findCnaeByWords(
    term: string,
    limit: number,
  ): Promise<{ codigo: string; descricao: string }[]> {
    const words = normalizeText(term).split(' ').filter(Boolean);
    if (words.length === 0) {
      return Promise.resolve([]);
    }
    const conditions = words.map((_, i) => `contains(descricao_norm, $${i + 1})`).join(' AND ');
    return this.db.all(
      `SELECT codigo, descricao FROM cnaes WHERE ${conditions} ORDER BY codigo LIMIT $${words.length + 1}`,
      [...words, limit],
    );
  }
}

function toCompany(row: CompanyRow, includeMeiContacts: boolean): Company {
  const hideContacts = row.mei && !includeMeiContacts;
  const phones = [formatPhone(row.ddd_1, row.telefone_1), formatPhone(row.ddd_2, row.telefone_2)];

  return {
    cnpj: formatCnpj(row.cnpj),
    razao_social: row.razao_social,
    nome_fantasia: row.nome_fantasia,
    matriz: row.matriz,
    situacao: statusLabel(row.situacao),
    data_abertura: row.data_abertura,
    cnae_principal: { codigo: formatCnae(row.cnae_principal), descricao: row.cnae_descricao },
    porte: sizeLabel(row.porte),
    mei: row.mei,
    simples: row.simples,
    capital_social: row.capital_social,
    endereco: row.endereco,
    bairro: row.bairro,
    cep: row.cep,
    municipio: row.municipio,
    uf: row.uf,
    telefones: hideContacts ? [] : phones.filter((phone): phone is string => phone !== null),
    email: hideContacts ? null : row.email,
    ...(hideContacts && (row.email || row.telefone_1) ? { contatos_ocultos: true as const } : {}),
  };
}

function toCsvLine(company: Company): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    cnpj: company.cnpj,
    razao_social: company.razao_social,
    nome_fantasia: company.nome_fantasia,
    matriz: company.matriz ? 'sim' : 'não',
    situacao: company.situacao,
    data_abertura: company.data_abertura,
    cnae_principal: company.cnae_principal.codigo,
    cnae_descricao: company.cnae_principal.descricao,
    porte: company.porte,
    mei: company.mei ? 'sim' : 'não',
    simples: company.simples ? 'sim' : 'não',
    capital_social: company.capital_social?.toFixed(2).replace('.', ','),
    endereco: company.endereco,
    bairro: company.bairro,
    cep: company.cep,
    municipio: company.municipio,
    uf: company.uf,
    telefone_1: company.telefones[0],
    telefone_2: company.telefones[1],
    email: company.email,
  };
  return CSV_COLUMNS.map((column) => csvField(values[column])).join(';');
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  let text = String(value);
  // Neutralize spreadsheet formulas (CSV injection) coming from public data.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[";\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
