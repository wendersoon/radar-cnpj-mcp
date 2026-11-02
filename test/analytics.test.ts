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
