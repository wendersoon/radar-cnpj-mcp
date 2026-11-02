import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths, percent, variation } from '../src/data/analytics.ts';
import { Database } from '../src/data/database.ts';
import { importDataset } from '../src/data/importer.ts';
import { CompanyRepository } from '../src/data/repository.ts';
import { createDatasetFolder } from './fixtures.ts';

let sourceDir: string;
let workDir: string;
let db: Database;
let analytics: CompanyRepository['analytics'];

beforeAll(async () => {
  sourceDir = await createDatasetFolder();
  workDir = await mkdtemp(join(tmpdir(), 'radar-analytics-'));
  const databasePath = join(workDir, 'radar.duckdb');
  await importDataset({ sourceDir, databasePath });

  // A namesake in another state, to exercise homonyms.
  const writable = await Database.open(databasePath);
  await writable.run("INSERT INTO municipios VALUES ('9999', 'SUMARE', 'SUMARE', 'MG')");
  writable.close();

  db = await Database.open(databasePath, { readOnly: true });
  analytics = new CompanyRepository(db).analytics;
});

afterAll(async () => {
  db?.close();
  await rm(sourceDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('moves across years', () => {
    expect(addMonths('2026-10-01', -12)).toBe('2025-10-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('does not divide by zero', () => {
    expect(percent(1, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.3);
    expect(variation(5, 0)).toBeNull();
    expect(variation(5, 4)).toBe(25);
    expect(variation(3, 4)).toBe(-25);
  });
});

describe('municipalityProfile', () => {
  it('answers "how is the economy of Campinas?"', async () => {
    const profile = await analytics.municipalityProfile('campinas', undefined, 10);

    expect(profile).toMatchObject({
      municipio: 'CAMPINAS',
      uf: 'SP',
      mes_referencia: '2026-10',
      estabelecimentos_registrados: 3,
      ativas: 2,
      percentual_ativas: 66.7,
      percentual_mei: 50,
      matrizes_ativas: 2,
      filiais_ativas: 0,
    });
    expect(profile.por_situacao).toEqual([
      { grupo: 'ATIVA', quantidade: 2, percentual: 66.7 },
      { grupo: 'BAIXADA', quantidade: 1, percentual: 33.3 },
    ]);
    expect(profile.principais_setores.map((sector) => sector.codigo).sort()).toEqual([
      '4520-0/01',
      '4520-0/02',
    ]);
    expect(profile.por_porte.map((size) => size.grupo).sort()).toEqual(['MEI', 'MICRO EMPRESA']);
    // Only complete months count: the MEI opened in 2026-08 is in, the window ends in 2026-09.
    expect(profile.aberturas).toMatchObject({
      periodo: { de: '2025-10-01', ate_exclusive: '2026-10-01' },
      periodo_anterior: { de: '2024-10-01', ate_exclusive: '2025-10-01' },
      aberturas: 1,
      aberturas_periodo_anterior: 0,
      variacao_percentual: null,
    });
  });

  it('never exposes individual companies', async () => {
    const text = JSON.stringify(await analytics.municipalityProfile('campinas', 'SP', 10));
    expect(text).not.toMatch(/OFICINA DO JOAO|JOAO DA SILVA|joao@example|999887766/);
  });

  it('limits the sectors listed', async () => {
    const { principais_setores } = await analytics.municipalityProfile('campinas', 'SP', 1);
    expect(principais_setores).toHaveLength(1);
  });

  it('asks for the state when the name is ambiguous', async () => {
    await expect(analytics.municipalityProfile('Sumaré', undefined, 5)).rejects.toThrow(
      /mais de um município.*MG, SP.*UF/,
    );
    const profile = await analytics.municipalityProfile('Sumaré', 'SP', 5);
    expect(profile.ativas).toBe(1);
  });

  it('reports a municipality that is not in the data instead of zeros', async () => {
    await expect(analytics.municipalityProfile('Atlantida', undefined, 5)).rejects.toThrow(
      /não encontrado.*buscar_municipio/,
    );
    await expect(analytics.municipalityProfile('Campinas', 'MG', 5)).rejects.toThrow(
      /não encontrado em MG/,
    );
  });
});

describe('compareRegions', () => {
  const allSectors = { incluir_cnae_secundario: false };

  it('answers "where are there more repair shops: Campinas or Sumaré?"', async () => {
    const { regioes, cnaes, mes_referencia } = await analytics.compareRegions(
      [
        { uf: 'SP', municipio: 'Campinas' },
        { uf: 'SP', municipio: 'sumaré' },
      ],
      { cnaes: ['4520001'], incluir_cnae_secundario: false },
    );

    expect(mes_referencia).toBe('2026-10');
    expect(cnaes).toEqual(['4520-0/01']);
    expect(regioes.map((region) => region.regiao)).toEqual(['CAMPINAS - SP', 'SUMARE - SP']);
    expect(regioes[0]).toMatchObject({
      ativas: 1,
      ativas_na_regiao: 2,
      participacao_nas_ativas: 50,
      percentual_mei: 0,
    });
    expect(regioes[1]).toMatchObject({
      ativas: 1,
      ativas_na_regiao: 1,
      participacao_nas_ativas: 100,
      filiais_ativas: 1,
    });
  });

  it('compares whole states in every sector', async () => {
    const { regioes, cnaes } = await analytics.compareRegions(
      [{ uf: 'SP' }, { uf: 'MG' }],
      allSectors,
    );
    expect(cnaes).toBeNull();
    expect(regioes.map((region) => [region.regiao, region.ativas])).toEqual([
      ['SP', 4],
      ['MG', 1],
    ]);
    expect(regioes[1]?.participacao_nas_ativas).toBe(100);
  });

  it('counts secondary activities only when asked', async () => {
    const region = [
      { uf: 'SP' as const, municipio: 'Campinas' },
      { uf: 'SP' as const, municipio: 'Sumaré' },
    ];
    const principal = await analytics.compareRegions(region, {
      cnaes: ['4520002'],
      incluir_cnae_secundario: false,
    });
    const secondary = await analytics.compareRegions(region, {
      cnaes: ['4520002'],
      incluir_cnae_secundario: true,
    });
    expect(principal.regioes[0]?.ativas).toBe(1);
    expect(secondary.regioes[0]?.ativas).toBe(2);
  });

  it('accepts a code prefix', async () => {
    const { regioes } = await analytics.compareRegions(
      [{ uf: 'SP', municipio: 'Campinas' }, { uf: 'MG' }],
      { cnaes: ['4520'], incluir_cnae_secundario: false },
    );
    expect(regioes.map((region) => region.ativas)).toEqual([2, 0]);
    expect(regioes[1]).toMatchObject({ percentual_mei: null, participacao_nas_ativas: 0 });
  });

  it('rejects what would look like a misleading zero', async () => {
    await expect(
      analytics.compareRegions([{ uf: 'SP', municipio: 'Campinas' }, { uf: 'RJ' }], allSectors),
    ).rejects.toThrow(/UF não importada: RJ/);
    await expect(
      analytics.compareRegions(
        [
          { uf: 'SP', municipio: 'Campinas' },
          { uf: 'SP', municipio: 'Atlantida' },
        ],
        allSectors,
      ),
    ).rejects.toThrow(/Atlantida.*não encontrado/);
    await expect(
      analytics.compareRegions([{ uf: 'SP' }, { uf: 'MG' }], {
        cnaes: ['9999999'],
        incluir_cnae_secundario: false,
      }),
    ).rejects.toThrow(/CNAE "9999-9\/99" não existe/);
    await expect(
      analytics.compareRegions([{ uf: 'SP' }, { uf: 'SP' }], allSectors),
    ).rejects.toThrow(/repetidas/);
  });
});
