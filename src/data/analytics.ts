import { sizeLabel, statusLabel, type UFS } from '../domain/codes.ts';
import { type Filters, filterSchema } from '../domain/filters.ts';
import { formatCnae, normalizeText } from '../domain/format.ts';
import type { Database, SqlParam } from './database.ts';
import { buildWhere, GROUP_EXPRESSIONS } from './query.ts';

type Uf = (typeof UFS)[number];

export class AnalyticsError extends Error {
  override name = 'AnalyticsError';
}

/** Two consecutive windows of complete months, ending before the reference month. */
export interface Comparison {
  /** Inclusive start and exclusive end, as AAAA-MM-DD. */
  periodo: { de: string; ate_exclusive: string };
  periodo_anterior: { de: string; ate_exclusive: string };
}

export interface OpeningsSummary extends Comparison {
  aberturas: number;
  aberturas_periodo_anterior: number;
  variacao_percentual: number | null;
}

export interface RegionSummary {
  estabelecimentos_registrados: number;
  ativas: number;
  percentual_ativas: number | null;
  percentual_mei: number | null;
  matrizes_ativas: number;
  filiais_ativas: number;
  por_porte: Share[];
  aberturas: OpeningsSummary;
}

export interface Share {
  grupo: string | null;
  quantidade: number;
  percentual: number | null;
}

export interface MunicipalityProfile extends RegionSummary {
  municipio: string;
  uf: string;
  mes_referencia: string | null;
  por_situacao: Share[];
  principais_setores: {
    codigo: string;
    descricao: string | null;
    quantidade: number;
    percentual: number | null;
  }[];
}

/** Aggregated views of the data. They return totals only, never individual companies. */
export class Analytics {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async municipalityProfile(
    name: string,
    uf: string | undefined,
    sectors: number,
  ): Promise<MunicipalityProfile> {
    const place = await this.resolveMunicipality(name, uf);
    const region = { ufs: [place.uf], municipios: [place.nome] };
    const summary = await this.regionSummary(region);

    const where = buildWhere(parseFilters({ ...region, situacao: 'todas' }));
    const statusRows = await this.db.all<{ grupo: string | null; quantidade: number }>(
      `SELECT situacao AS grupo, count(*)::INTEGER AS quantidade
       FROM estabelecimentos ${where.sql}
       GROUP BY grupo ORDER BY quantidade DESC, grupo`,
      where.params,
    );

    const active = buildWhere(parseFilters(region));
    const sectorRows = await this.db.all<{
      codigo: string;
      descricao: string | null;
      quantidade: number;
    }>(
      `SELECT cnae_principal AS codigo, any_value(cnae_descricao) AS descricao,
              count(*)::INTEGER AS quantidade
       FROM estabelecimentos ${active.sql}
       GROUP BY codigo ORDER BY quantidade DESC, codigo LIMIT $${active.params.length + 1}`,
      [...active.params, sectors],
    );

    return {
      municipio: place.nome,
      uf: place.uf,
      mes_referencia: await this.referenceMonth(),
      ...summary,
      por_situacao: statusRows.map((row) => ({
        grupo: statusLabel(row.grupo),
        quantidade: row.quantidade,
        percentual: percent(row.quantidade, summary.estabelecimentos_registrados),
      })),
      principais_setores: sectorRows.map((row) => ({
        codigo: formatCnae(row.codigo),
        descricao: row.descricao,
        quantidade: row.quantidade,
        percentual: percent(row.quantidade, summary.ativas),
      })),
    };
  }

  /** Summarizes the establishments matching the filters; their own situacao is ignored. */
  async regionSummary(filters: Partial<Filters>): Promise<RegionSummary> {
    const comparison = await this.lastTwelveMonths();
    const where = buildWhere(parseFilters({ ...filters, situacao: 'todas' }));
    const n = where.params.length;
    const params: SqlParam[] = [
      ...where.params,
      comparison.periodo_anterior.de,
      comparison.periodo.de,
      comparison.periodo.ate_exclusive,
    ];
    const [totals] = await this.db.all<{
      total: number;
      ativas: number;
      mei: number;
      matrizes: number;
      atual: number;
      anterior: number;
    }>(
      `SELECT count(*)::INTEGER AS total,
              count_if(situacao = '02')::INTEGER AS ativas,
              count_if(situacao = '02' AND mei)::INTEGER AS mei,
              count_if(situacao = '02' AND matriz)::INTEGER AS matrizes,
              count_if(data_abertura >= $${n + 2}::DATE AND data_abertura < $${n + 3}::DATE)::INTEGER AS atual,
              count_if(data_abertura >= $${n + 1}::DATE AND data_abertura < $${n + 2}::DATE)::INTEGER AS anterior
       FROM estabelecimentos ${where.sql}`,
      params,
    );

    const active = buildWhere(parseFilters({ ...filters, situacao: 'ativa' }));
    const sizes = await this.db.all<{ grupo: string | null; quantidade: number }>(
      `SELECT ${GROUP_EXPRESSIONS.porte} AS grupo, count(*)::INTEGER AS quantidade
       FROM estabelecimentos ${active.sql}
       GROUP BY grupo ORDER BY quantidade DESC, grupo`,
      active.params,
    );

    const ativas = totals?.ativas ?? 0;
    const matrizes = totals?.matrizes ?? 0;
    const atual = totals?.atual ?? 0;
    const anterior = totals?.anterior ?? 0;
    return {
      estabelecimentos_registrados: totals?.total ?? 0,
      ativas,
      percentual_ativas: percent(ativas, totals?.total ?? 0),
      percentual_mei: percent(totals?.mei ?? 0, ativas),
      matrizes_ativas: matrizes,
      filiais_ativas: ativas - matrizes,
      por_porte: sizes.map((row) => ({
        grupo: sizeLabel(row.grupo),
        quantidade: row.quantidade,
        percentual: percent(row.quantidade, ativas),
      })),
      aberturas: {
        ...comparison,
        aberturas: atual,
        aberturas_periodo_anterior: anterior,
        variacao_percentual: variation(atual, anterior),
      },
    };
  }

  async resolveMunicipality(name: string, uf?: string): Promise<{ nome: string; uf: Uf }> {
    const normalized = normalizeText(name);
    const params: SqlParam[] = uf ? [normalized, uf] : [normalized];
    const matches = await this.db.all<{ nome: string; uf: Uf }>(
      `SELECT nome, uf FROM municipios WHERE nome_norm = $1 ${uf ? 'AND uf = $2' : ''} ORDER BY uf`,
      params,
    );
    const [first, ...others] = matches;
    if (!first) {
      const where = uf ? ` em ${uf}` : '';
      throw new AnalyticsError(
        `Município "${name}" não encontrado${where} entre as UFs importadas. ` +
          'Confira o nome com buscar_municipio e as UFs com status_base.',
      );
    }
    if (others.length > 0) {
      throw new AnalyticsError(
        `Há mais de um município chamado "${first.nome}" (${matches.map((m) => m.uf).join(', ')}). Informe a UF.`,
      );
    }
    return first;
  }

  async referenceMonth(): Promise<string | null> {
    const [row] = await this.db.all<{ valor: string | null }>(
      "SELECT valor FROM metadados WHERE chave = 'mes_referencia'",
    );
    return row?.valor ?? null;
  }

  /** First day of the reference month: the months before it are the complete ones. */
  async dataEnd(): Promise<string> {
    const month = await this.referenceMonth();
    if (month) {
      return `${month}-01`;
    }
    // Imported from a folder without the month in its name.
    const [row] = await this.db.all<{ fim: string | null }>(
      `SELECT strftime(date_trunc('month', max(data_abertura)), '%Y-%m-%d') AS fim
       FROM estabelecimentos WHERE data_abertura <= current_date`,
    );
    if (!row?.fim) {
      throw new AnalyticsError('A base não tem datas de abertura.');
    }
    return row.fim;
  }

  private async lastTwelveMonths(): Promise<Comparison> {
    const end = await this.dataEnd();
    const start = addMonths(end, -12);
    return {
      periodo: { de: start, ate_exclusive: end },
      periodo_anterior: { de: addMonths(end, -24), ate_exclusive: start },
    };
  }
}

function parseFilters(filters: Partial<Filters>): Filters {
  return filterSchema.parse(filters);
}

export function addMonths(isoDate: string, months: number): string {
  const [year = 0, month = 1] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 10);
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function variation(current: number, previous: number): number | null {
  return previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
}
