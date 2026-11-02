import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/data/database.ts';
import { defaultMemoryLimit, ImportError, importDataset } from '../src/data/importer.ts';
import { CompanyRepository } from '../src/data/repository.ts';
import { countSchema, searchSchema } from '../src/domain/filters.ts';
import { createDatasetFolder } from './fixtures.ts';

let sourceDir: string;
let workDir: string;
let db: Database;
let repo: CompanyRepository;

const search = (input: object) => repo.search(searchSchema.parse(input));
const cnpjs = async (input: object) => (await search(input)).empresas.map((c) => c.cnpj);

beforeAll(async () => {
  sourceDir = await createDatasetFolder();
  workDir = await mkdtemp(join(tmpdir(), 'radar-db-'));
  const databasePath = join(workDir, 'radar.duckdb');

  const summary = await importDataset({ sourceDir, databasePath, states: ['sp'] });
  expect(summary).toMatchObject({ establishments: 5, states: ['SP'], referenceMonth: '2026-10' });

  db = await Database.open(databasePath, { readOnly: true });
  repo = new CompanyRepository(db);
});

afterAll(async () => {
  db?.close();
  await rm(sourceDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('import', () => {
  it('records the dataset status', async () => {
    expect(await repo.status()).toMatchObject({
      mes_referencia: '2026-10',
      ufs: ['SP'],
      estabelecimentos: 5,
    });
  });

  it('imports the whole country without a state filter', async () => {
    const path = join(workDir, 'all.duckdb');
    const summary = await importDataset({ sourceDir, databasePath: path });
    expect(summary.establishments).toBe(6);
  });

  it('produces the same data when processing tiny chunks', async () => {
    const path = join(workDir, 'chunked.duckdb');
    const summary = await importDataset({ sourceDir, databasePath: path, chunkBytes: 64 });
    expect(summary.establishments).toBe(6);
    expect(await readdir(workDir)).not.toContainEqual(expect.stringMatching(/^\.radar-import-/));
  });

  it('cleans up after imports that were killed and honors a memory limit', async () => {
    const dir = await mkdtemp(join(workDir, 'killed-'));
    await mkdir(join(dir, '.radar-import-old'));
    const path = join(dir, 'radar.duckdb');
    await importDataset({ sourceDir, databasePath: path, memoryLimit: '512MB' });
    expect(await readdir(dir)).toEqual(['radar.duckdb']);
  });

  it('rejects folders without the required files', async () => {
    await expect(
      importDataset({ sourceDir: workDir, databasePath: join(workDir, 'x.duckdb') }),
    ).rejects.toThrow(ImportError);
  });

  it('rejects unknown states', async () => {
    await expect(
      importDataset({ sourceDir, databasePath: join(workDir, 'y.duckdb'), states: ['XX'] }),
    ).rejects.toThrow('UF inválida: XX');
  });
});

describe('memory limit', () => {
  it('uses 30% of the RAM, at least 1 GB', () => {
    expect(defaultMemoryLimit(16 * 1024 ** 3)).toBe('4915MB');
    expect(defaultMemoryLimit(2 * 1024 ** 3)).toBe('1024MB');
  });
});

describe('search', () => {
  it('finds active companies by exact CNAE, newest first', async () => {
    expect(await cnpjs({ cnaes: ['4520-0/01'] })).toEqual([
      '11.111.111/0002-72',
      '11.111.111/0001-91',
    ]);
  });

  it('matches CNAE prefixes and secondary activities', async () => {
    expect(await cnpjs({ cnaes: ['4520'] })).toHaveLength(3);
    expect(await cnpjs({ cnaes: ['4520002'], incluir_cnae_secundario: true })).toEqual([
      '22.222.222/0001-10',
      '11.111.111/0001-91',
    ]);
  });

  it('filters by city and neighborhood ignoring case and accents', async () => {
    expect(await cnpjs({ municipios: ['campinas'], cnaes: ['4520'] })).toEqual([
      '22.222.222/0001-10',
      '11.111.111/0001-91',
    ]);
    expect(await cnpjs({ bairros: ['sao jose'] })).toEqual(['11.111.111/0002-72']);
  });

  it('filters by status, opening date, MEI, size and capital', async () => {
    expect(await cnpjs({ cnaes: ['4520'], situacao: 'todas' })).toHaveLength(4);
    expect(await cnpjs({ aberta_apos: '2025-01-01' })).toEqual([
      '22.222.222/0001-10',
      '11.111.111/0002-72',
    ]);
    expect(await cnpjs({ cnaes: ['4520'], mei: 'excluir' })).not.toContain('22.222.222/0001-10');
    expect(await cnpjs({ mei: 'somente' })).toEqual(['22.222.222/0001-10']);
    expect(await cnpjs({ portes: ['demais'] })).toEqual(['33.333.333/0001-20']);
    expect(await cnpjs({ capital_min: 100000 })).toEqual(['33.333.333/0001-20']);
    expect(await cnpjs({ ceps: ['0131'] })).toEqual(['33.333.333/0001-20']);
    expect(await cnpjs({ somente_matriz: true, cnaes: ['4520001'] })).toEqual([
      '11.111.111/0001-91',
    ]);
  });

  it('returns formatted company records', async () => {
    const result = await search({ cnaes: ['4520001'], somente_matriz: true });
    expect(result.total).toBe(1);
    expect(result.empresas[0]).toEqual({
      cnpj: '11.111.111/0001-91',
      razao_social: 'OFICINA DO JOAO LTDA',
      nome_fantasia: 'OFICINA SÃO JOÃO',
      matriz: true,
      situacao: 'ATIVA',
      data_abertura: '2024-03-15',
      cnae_principal: {
        codigo: '4520-0/01',
        descricao: 'Serviços de manutenção e reparação mecânica de veículos automotores',
      },
      porte: 'MICRO EMPRESA',
      mei: false,
      simples: true,
      capital_social: 50000,
      endereco: 'RUA BARAO DE JAGUARA, 100',
      bairro: 'CENTRO',
      cep: '13015000',
      municipio: 'CAMPINAS',
      uf: 'SP',
      telefones: ['(19) 3234-5678'],
      email: 'contato@oficina.com.br',
    });
  });

  it('removes the CPF that Receita appends to sole proprietor names', async () => {
    const [mei] = (await search({ mei: 'somente' })).empresas;
    expect(mei?.razao_social).toBe('JOAO DA SILVA');
  });

  it('removes CPFs from every free-text field', async () => {
    const company = await repo.getCompany('55555555000140');
    expect(company).toMatchObject({
      nome_fantasia: 'FUNILARIA CENTRAL',
      endereco: 'RUA JOSE PAULINO, 100',
      bairro: 'CENTRO',
      email: null,
    });
    expect((await search({ bairros: ['529'], situacao: 'todas' })).total).toBe(0);
  });

  it('shows MEI contacts unless asked to hide them', async () => {
    const [hidden] = (await search({ mei: 'somente', ocultar_contatos_mei: true })).empresas;
    expect(hidden).toMatchObject({ telefones: [], email: null, contatos_ocultos: true });

    const [shown] = (await search({ mei: 'somente' })).empresas;
    expect(shown).toMatchObject({ telefones: ['(19) 99988-7766'], email: 'joao@example.com' });
    expect(shown).not.toHaveProperty('contatos_ocultos');
  });

  it('paginates', async () => {
    const page = await search({ limite: 2, deslocamento: 2, ordenar_por: 'nome' });
    expect(page.total).toBe(4);
    expect(page.empresas.map((c) => c.razao_social)).toEqual([
      'OFICINA DO JOAO LTDA',
      'SUPERMERCADO BOM PRECO LTDA',
    ]);
  });
});

describe('count', () => {
  it('groups by city', async () => {
    const result = await repo.count(
      countSchema.parse({ cnaes: ['4520'], agrupar_por: 'municipio' }),
    );
    expect(result).toEqual({
      total: 3,
      grupos: [
        { grupo: 'CAMPINAS - SP', quantidade: 2 },
        { grupo: 'SUMARE - SP', quantidade: 1 },
      ],
    });
  });

  it('labels company sizes, keeping MEIs apart from micro companies', async () => {
    const result = await repo.count(countSchema.parse({ agrupar_por: 'porte' }));
    expect(result.grupos).toEqual([
      { grupo: 'MICRO EMPRESA', quantidade: 2 },
      { grupo: 'DEMAIS', quantidade: 1 },
      { grupo: 'MEI', quantidade: 1 },
    ]);
  });

  it('splits MEIs from other companies', async () => {
    const result = await repo.count(countSchema.parse({ agrupar_por: 'mei' }));
    expect(result.grupos).toEqual([
      { grupo: 'NAO MEI', quantidade: 3 },
      { grupo: 'MEI', quantidade: 1 },
    ]);
  });
});

describe('lookups', () => {
  it('finds CNAE codes by words or code prefix', async () => {
    expect(await repo.findCnae('reparação mecânica')).toEqual([
      {
        codigo: '4520-0/01',
        descricao: 'Serviços de manutenção e reparação mecânica de veículos automotores',
      },
    ]);
    expect((await repo.findCnae('4520-0')).map((c) => c.codigo)).toEqual([
      '4520-0/01',
      '4520-0/02',
    ]);
  });

  it('finds municipalities of the imported states', async () => {
    expect(await repo.findMunicipality('são paulo')).toEqual([
      { codigo: '7107', nome: 'SAO PAULO', uf: 'SP' },
    ]);
    expect(await repo.findMunicipality('belo horizonte')).toEqual([]);
  });

  it('details a company with its secondary activities', async () => {
    const company = await repo.getCompany('11111111000191');
    expect(company).toMatchObject({
      razao_social: 'OFICINA DO JOAO LTDA',
      natureza_juridica: '2062',
      cnaes_secundarios: [
        {
          codigo: '4520-0/02',
          descricao: 'Serviços de lanternagem ou funilaria e pintura de veículos automotores',
        },
      ],
    });
    expect(await repo.getCompany('00.000.000/0000-00')).toBeNull();
  });

  it('cleans stray control bytes from the source files', async () => {
    expect((await repo.getCompany('33333333000120'))?.nome_fantasia).toBe('MERCADO BOM PRECO');
  });
});

describe('export', () => {
  it('writes a spreadsheet-friendly CSV', async () => {
    const path = join(workDir, 'empresas.csv');
    const params = searchSchema.parse({ cnaes: ['4520'] });
    expect(await repo.exportCsv(params, path, 10)).toBe(3);

    const lines = (await readFile(path, 'utf8')).split('\r\n');
    expect(lines[0]?.startsWith('﻿cnpj;razao_social;')).toBe(true);
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain(
      '11.111.111/0001-91;OFICINA DO JOAO LTDA;OFICINA SÃO JOÃO;sim;ATIVA',
    );
    expect(lines[3]).toContain('50000,00');
  });

  it('respects the row limit', async () => {
    const path = join(workDir, 'one.csv');
    expect(await repo.exportCsv(searchSchema.parse({}), path, 1)).toBe(1);
  });
});
