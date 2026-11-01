import { SIZE_CODES, STATUS_CODES } from '../domain/codes.ts';
import type { Filters, Grouping, SearchParams } from '../domain/filters.ts';
import { normalizeText } from '../domain/format.ts';
import type { SqlParam } from './database.ts';

/** A SQL fragment with its positional parameters ($1, $2, ...). */
export interface SqlFragment {
  sql: string;
  params: SqlParam[];
}

class ParamList {
  readonly values: SqlParam[] = [];

  add(value: SqlParam): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  addAll(values: readonly SqlParam[]): string {
    return values.map((value) => this.add(value)).join(', ');
  }
}

const FULL_CNAE_LENGTH = 7;

/** Builds the WHERE clause matching the given filters over the estabelecimentos table. */
export function buildWhere(filters: Filters): SqlFragment {
  const p = new ParamList();
  const conditions: string[] = [];

  if (filters.situacao !== 'todas') {
    conditions.push(`situacao = ${p.add(STATUS_CODES[filters.situacao])}`);
  }

  if (filters.cnaes) {
    conditions.push(cnaeCondition(p, filters.cnaes, filters.incluir_cnae_secundario));
  }

  if (filters.ufs) {
    conditions.push(`uf IN (${p.addAll(filters.ufs)})`);
  }

  if (filters.municipios) {
    conditions.push(`municipio_norm IN (${p.addAll(filters.municipios.map(normalizeText))})`);
  }

  if (filters.bairros) {
    const likes = filters.bairros.map(
      (bairro) => `bairro_norm LIKE ${p.add(`%${escapeLike(normalizeText(bairro))}%`)} ESCAPE '\\'`,
    );
    conditions.push(`(${likes.join(' OR ')})`);
  }

  if (filters.ceps) {
    const prefixes = filters.ceps.map((cep) => `starts_with(cep, ${p.add(cep)})`);
    conditions.push(`(${prefixes.join(' OR ')})`);
  }

  if (filters.aberta_apos) {
    conditions.push(`data_abertura >= ${p.add(filters.aberta_apos)}::DATE`);
  }

  if (filters.aberta_antes) {
    conditions.push(`data_abertura <= ${p.add(filters.aberta_antes)}::DATE`);
  }

  if (filters.portes) {
    conditions.push(`porte IN (${p.addAll(filters.portes.map((size) => SIZE_CODES[size]))})`);
  }

  if (filters.mei === 'excluir') {
    conditions.push('NOT mei');
  } else if (filters.mei === 'somente') {
    conditions.push('mei');
  }

  if (filters.somente_matriz) {
    conditions.push('matriz');
  }

  if (filters.capital_min !== undefined) {
    conditions.push(`capital_social >= ${p.add(filters.capital_min)}`);
  }

  if (filters.capital_max !== undefined) {
    conditions.push(`capital_social <= ${p.add(filters.capital_max)}`);
  }

  if (filters.com_telefone) {
    conditions.push('telefone_1 IS NOT NULL');
  }

  if (filters.com_email) {
    conditions.push('email IS NOT NULL');
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params: p.values,
  };
}

function cnaeCondition(p: ParamList, codes: readonly string[], includeSecondary: boolean): string {
  const exact = codes.filter((code) => code.length === FULL_CNAE_LENGTH);
  const prefixes = codes.filter((code) => code.length < FULL_CNAE_LENGTH);
  const alternatives: string[] = [];

  if (exact.length > 0) {
    const list = p.addAll(exact);
    alternatives.push(`cnae_principal IN (${list})`);
    if (includeSecondary) {
      alternatives.push(`list_has_any(cnaes_secundarios, [${list}])`);
    }
  }

  for (const prefix of prefixes) {
    const param = p.add(prefix);
    alternatives.push(`starts_with(cnae_principal, ${param})`);
    if (includeSecondary) {
      alternatives.push(
        `len(list_filter(cnaes_secundarios, lambda x: starts_with(x, ${param}))) > 0`,
      );
    }
  }

  return `(${alternatives.join(' OR ')})`;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export const ORDER_BY: Record<SearchParams['ordenar_por'], string> = {
  mais_recentes: 'data_abertura DESC NULLS LAST, cnpj',
  mais_antigas: 'data_abertura ASC NULLS LAST, cnpj',
  maior_capital: 'capital_social DESC NULLS LAST, cnpj',
  nome: 'razao_social ASC NULLS LAST, cnpj',
};

export const GROUP_EXPRESSIONS: Record<Grouping, string> = {
  uf: 'uf',
  municipio: "concat_ws(' - ', municipio, uf)",
  bairro: "concat_ws(' - ', coalesce(bairro, '(sem bairro)'), municipio, uf)",
  cnae: "concat_ws(' - ', cnae_principal, cnae_descricao)",
  // For Receita a MEI is a micro company; report it on its own, as people expect.
  porte: "CASE WHEN mei THEN 'MEI' ELSE porte END",
  mei: "CASE WHEN mei THEN 'MEI' ELSE 'NAO MEI' END",
  ano_abertura: 'CAST(year(data_abertura) AS VARCHAR)',
};
