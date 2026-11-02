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

export interface ComparedRegion extends RegionSummary {
  regiao: string;
  /** Active establishments of the region, in any sector. */
  ativas_na_regiao: number;
  /** Share of the region's active establishments that belong to the sector. */
  participacao_nas_ativas: number | null;
}

export interface RegionComparison {
  mes_referencia: string | null;
  /** Compared sector; null means every sector. */
  cnaes: string[] | null;
  inclui_cnae_secundario: boolean;
  regioes: ComparedRegion[];
}

export type TrendPeriodicity = 'ano' | 'mes';

export interface TrendPoint {
  periodo: string;
  aberturas: number;
  baixas: number;
  saldo: number;
  /** The period is not over in the data, so it is not comparable with the others. */
  parcial?: true;
}

export interface SectorTrend extends Comparison {
  mes_referencia: string | null;
  periodicidade: TrendPeriodicity;
  serie: TrendPoint[];
  aberturas: number;
  aberturas_periodo_anterior: number;
  variacao_aberturas_percentual: number | null;
  baixas: number;
  baixas_periodo_anterior: number;
  variacao_baixas_percentual: number | null;
  observacao: string;
}

const TREND_NOTE =
  'Calculado a partir de um único retrato da base. Aberturas incluem empresas que já fecharam. ' +
  'Baixas contam só quem está baixado hoje, pela data da situação cadastral, e picos podem vir ' +
  'de baixas feitas em lote pela Receita, não de fechamentos do setor.';

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

  /** Compares the same sector across regions, in the order they were given. */
  async compareRegions(
    regions: readonly { uf: Uf; municipio?: string | undefined }[],
    sector: Pick<Filters, 'cnaes' | 'incluir_cnae_secundario'>,
  ): Promise<RegionComparison> {
    await this.assertCnaesExist(sector.cnaes);

    const places: { name: string; region: Partial<Filters> }[] = [];
    for (const { uf, municipio } of regions) {
      if (municipio) {
        const place = await this.resolveMunicipality(municipio, uf);
        places.push({
          name: `${place.nome} - ${place.uf}`,
          region: { ufs: [place.uf], municipios: [place.nome] },
        });
      } else {
        await this.assertStatesImported([uf]);
        places.push({ name: uf, region: { ufs: [uf] } });
      }
    }
    if (new Set(places.map((place) => place.name)).size < places.length) {
      throw new AnalyticsError('Há regiões repetidas na comparação.');
    }

    const compared: ComparedRegion[] = [];
    for (const { name, region } of places) {
      const summary = await this.regionSummary({ ...region, ...sector });
      const allSectors = sector.cnaes ? await this.count(parseFilters(region)) : summary.ativas;
      compared.push({
        regiao: name,
        ...summary,
        ativas_na_regiao: allSectors,
        participacao_nas_ativas: percent(summary.ativas, allSectors),
      });
    }

    return {
      mes_referencia: await this.referenceMonth(),
      cnaes: sector.cnaes?.map(formatCnae) ?? null,
      inclui_cnae_secundario: sector.incluir_cnae_secundario,
      regioes: compared,
    };
  }

  /** Openings and closures over time, reconstructed from the dates in the current data. */
  async sectorTrend(
    filters: Pick<Filters, 'cnaes' | 'incluir_cnae_secundario' | 'ufs' | 'municipios' | 'mei'>,
    periodicity: TrendPeriodicity,
    periods: number,
  ): Promise<SectorTrend> {
    await this.assertCnaesExist(filters.cnaes);
    await this.assertRegions(filters.ufs, filters.municipios);

    const end = await this.dataEnd();
    const labels = periodLabels(end, periodicity, periods);
    const start = periodicity === 'ano' ? `${labels[0]}-01-01` : `${labels[0]}-01`;
    const format = periodicity === 'ano' ? '%Y' : '%Y-%m';

    const where = buildWhere(parseFilters({ ...filters, situacao: 'todas' }));
    const n = where.params.length;
    const and = where.sql ? `${where.sql} AND` : 'WHERE';
    const inRange = (column: string) =>
      `${column} >= $${n + 1}::DATE AND ${column} < $${n + 2}::DATE`;
    const series = (column: string, extra = '') =>
      this.db.all<{ periodo: string; quantidade: number }>(
        `SELECT strftime(${column}, '${format}') AS periodo, count(*)::INTEGER AS quantidade
         FROM estabelecimentos ${and} ${inRange(column)} ${extra}
         GROUP BY periodo`,
        [...where.params, start, end],
      );
    const opened = new Map(
      (await series('data_abertura')).map((row) => [row.periodo, row.quantidade]),
    );
    const closed = new Map(
      (await series('data_situacao', "AND situacao = '08'")).map((row) => [
        row.periodo,
        row.quantidade,
      ]),
    );

    const lastIsPartial = periodicity === 'ano' && !end.endsWith('-01-01');
    const serie = labels.map((periodo, index): TrendPoint => {
      const aberturas = opened.get(periodo) ?? 0;
      const baixas = closed.get(periodo) ?? 0;
      return {
        periodo,
        aberturas,
        baixas,
        saldo: aberturas - baixas,
        ...(lastIsPartial && index === labels.length - 1 ? { parcial: true as const } : {}),
      };
    });

    const comparison = await this.lastTwelveMonths();
    const window = (column: string, from: string, to: string, extra = '') =>
      this.windowCount(and, where.params, column, from, to, extra);
    const { periodo, periodo_anterior: previous } = comparison;
    const aberturas = await window('data_abertura', periodo.de, periodo.ate_exclusive);
    const aberturasAntes = await window('data_abertura', previous.de, previous.ate_exclusive);
    const closedOnly = "AND situacao = '08'";
    const baixas = await window('data_situacao', periodo.de, periodo.ate_exclusive, closedOnly);
    const baixasAntes = await window(
      'data_situacao',
      previous.de,
      previous.ate_exclusive,
      closedOnly,
    );

    return {
      mes_referencia: await this.referenceMonth(),
      periodicidade: periodicity,
      serie,
      ...comparison,
      aberturas,
      aberturas_periodo_anterior: aberturasAntes,
      variacao_aberturas_percentual: variation(aberturas, aberturasAntes),
      baixas,
      baixas_periodo_anterior: baixasAntes,
      variacao_baixas_percentual: variation(baixas, baixasAntes),
      observacao: TREND_NOTE,
    };
  }

  private async windowCount(
    and: string,
    params: SqlParam[],
    column: string,
    from: string,
    to: string,
    extra: string,
  ): Promise<number> {
    const n = params.length;
    const [row] = await this.db.all<{ total: number }>(
      `SELECT count(*)::INTEGER AS total FROM estabelecimentos
       ${and} ${column} >= $${n + 1}::DATE AND ${column} < $${n + 2}::DATE ${extra}`,
      [...params, from, to],
    );
    return row?.total ?? 0;
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

  async assertStatesImported(states: readonly string[]): Promise<void> {
    const rows = await this.db.all<{ uf: string }>('SELECT DISTINCT uf FROM municipios');
    const imported = new Set(rows.map((row) => row.uf));
    const missing = states.filter((state) => !imported.has(state));
    if (missing.length > 0) {
      throw new AnalyticsError(
        `UF não importada: ${missing.join(', ')}. Importadas: ${[...imported].sort().join(', ')}.`,
      );
    }
  }

  /** Without a state, a repeated name would silently add up different cities. */
  async assertRegions(
    states: readonly string[] | undefined,
    municipalities: readonly string[] | undefined,
  ): Promise<void> {
    if (states) {
      await this.assertStatesImported(states);
    }
    for (const name of municipalities ?? []) {
      if (!states) {
        await this.resolveMunicipality(name);
        continue;
      }
      const [row] = await this.db.all(
        `SELECT 1 AS existe FROM municipios
         WHERE nome_norm = $1 AND uf IN (${states.map((_, i) => `$${i + 2}`).join(', ')}) LIMIT 1`,
        [normalizeText(name), ...states],
      );
      if (!row) {
        throw new AnalyticsError(
          `Município "${name}" não encontrado em ${states.join(', ')}. Confira com buscar_municipio.`,
        );
      }
    }
  }

  async assertCnaesExist(codes: readonly string[] | undefined): Promise<void> {
    for (const code of codes ?? []) {
      const [row] = await this.db.all(
        'SELECT 1 AS existe FROM cnaes WHERE starts_with(codigo, $1) LIMIT 1',
        [code],
      );
      if (!row) {
        throw new AnalyticsError(
          `CNAE "${formatCnae(code)}" não existe. Descubra o código com buscar_cnae.`,
        );
      }
    }
  }

  private async count(filters: Filters): Promise<number> {
    const where = buildWhere(filters);
    const [row] = await this.db.all<{ total: number }>(
      `SELECT count(*)::INTEGER AS total FROM estabelecimentos ${where.sql}`,
      where.params,
    );
    return row?.total ?? 0;
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

/** The last periods with data, oldest first. The data ends before `end`. */
export function periodLabels(end: string, periodicity: TrendPeriodicity, count: number): string[] {
  const last = addMonths(end, -1);
  const labels: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    labels.push(
      periodicity === 'ano'
        ? String(Number(last.slice(0, 4)) - i)
        : addMonths(last, -i).slice(0, 7),
    );
  }
  return labels;
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
