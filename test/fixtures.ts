import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';

type Row = string[];

const cnaes: Row[] = [
  ['4520001', 'Serviços de manutenção e reparação mecânica de veículos automotores'],
  ['4520002', 'Serviços de lanternagem ou funilaria e pintura de veículos automotores'],
  ['4711302', 'Comércio varejista de mercadorias em geral - supermercados'],
  ['8630504', 'Atividade odontológica'],
];

const municipios: Row[] = [
  ['6291', 'CAMPINAS'],
  ['6297', 'SUMARE'],
  ['7107', 'SAO PAULO'],
  ['4123', 'BELO HORIZONTE'],
];

const empresas: Row[] = [
  ['11111111', 'OFICINA DO JOAO LTDA', '2062', '49', '50000,00', '01', ''],
  ['22222222', 'JOAO DA SILVA 12345678900', '2135', '50', '5000,00', '01', ''],
  ['33333333', 'SUPERMERCADO BOM PRECO LTDA', '2062', '49', '1000000,00', '05', ''],
  ['44444444', 'ODONTO BH LTDA', '2062', '49', '200000,00', '03', ''],
  ['55555555', 'FUNILARIA CENTRAL LTDA', '2062', '49', '30000,00', '01', ''],
];

const simples: Row[] = [
  ['11111111', 'S', '20240315', '', 'N', '', ''],
  ['22222222', 'S', '20260801', '', 'S', '20260801', ''],
];

function establishment(fields: {
  basico: string;
  ordem: string;
  dv: string;
  matriz: boolean;
  fantasia?: string;
  situacao: string;
  abertura: string;
  cnae: string;
  secundarios?: string;
  logradouro: string;
  bairro: string;
  cep: string;
  uf: string;
  municipio: string;
  ddd?: string;
  telefone?: string;
  email?: string;
}): Row {
  return [
    fields.basico,
    fields.ordem,
    fields.dv,
    fields.matriz ? '1' : '2',
    fields.fantasia ?? '',
    fields.situacao,
    fields.abertura,
    '00',
    '',
    '',
    fields.abertura,
    fields.cnae,
    fields.secundarios ?? '',
    'RUA',
    fields.logradouro,
    '100',
    '',
    fields.bairro,
    fields.cep,
    fields.uf,
    fields.municipio,
    fields.ddd ?? '',
    fields.telefone ?? '',
    '',
    '',
    '',
    '',
    fields.email ?? '',
    '',
    '',
  ];
}

const estabelecimentos: Row[] = [
  establishment({
    basico: '11111111',
    ordem: '0001',
    dv: '91',
    matriz: true,
    fantasia: 'OFICINA SÃO JOÃO',
    situacao: '02',
    abertura: '20240315',
    cnae: '4520001',
    secundarios: '4520002',
    logradouro: 'BARAO DE JAGUARA',
    bairro: 'CENTRO',
    cep: '13015000',
    uf: 'SP',
    municipio: '6291',
    ddd: '19',
    telefone: '32345678',
    email: 'CONTATO@OFICINA.COM.BR',
  }),
  establishment({
    basico: '11111111',
    ordem: '0002',
    dv: '72',
    matriz: false,
    situacao: '02',
    abertura: '20250110',
    cnae: '4520001',
    logradouro: 'DAS FLORES',
    bairro: 'JARDIM SÃO JOSÉ',
    cep: '13170000',
    uf: 'SP',
    municipio: '6297',
  }),
  establishment({
    basico: '22222222',
    ordem: '0001',
    dv: '10',
    matriz: true,
    situacao: '02',
    abertura: '20260801',
    cnae: '4520002',
    logradouro: 'DOS ANDRADAS',
    bairro: 'CENTRO',
    cep: '13010000',
    uf: 'SP',
    municipio: '6291',
    ddd: '19',
    telefone: '999887766',
    email: 'joao@example.com',
  }),
  establishment({
    basico: '33333333',
    ordem: '0001',
    dv: '20',
    matriz: true,
    situacao: '02',
    abertura: '20100505',
    cnae: '4711302',
    logradouro: 'PAULISTA',
    bairro: 'BELA VISTA',
    cep: '01310000',
    uf: 'SP',
    municipio: '7107',
  }),
  establishment({
    basico: '44444444',
    ordem: '0001',
    dv: '30',
    matriz: true,
    situacao: '02',
    abertura: '20180101',
    cnae: '8630504',
    logradouro: 'AFONSO PENA',
    bairro: 'CENTRO',
    cep: '30130000',
    uf: 'MG',
    municipio: '4123',
  }),
  establishment({
    basico: '55555555',
    ordem: '0001',
    dv: '40',
    matriz: true,
    situacao: '08',
    abertura: '20150101',
    cnae: '4520002',
    logradouro: 'JOSE PAULINO',
    bairro: 'CENTRO',
    cep: '13013000',
    uf: 'SP',
    municipio: '6291',
  }),
];

function toCsv(rows: Row[]): Buffer {
  const text = rows.map((row) => row.map((field) => `"${field}"`).join(';')).join('\n');
  return Buffer.from(`${text}\n`, 'latin1');
}

async function writeZip(path: string, entryName: string, rows: Row[]): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(toCsv(rows), entryName);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

/** Creates a folder that mimics a monthly Receita Federal release. */
export async function createDatasetFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'radar-fixture-2026-10-'));
  // Split establishments across two archives, like the real release.
  await writeZip(
    join(dir, 'Estabelecimentos0.zip'),
    'K3241.ESTABELE',
    estabelecimentos.slice(0, 3),
  );
  await writeZip(join(dir, 'Estabelecimentos1.zip'), 'K3242.ESTABELE', estabelecimentos.slice(3));
  await writeZip(join(dir, 'Empresas0.zip'), 'K3241.EMPRECSV', empresas);
  await writeZip(join(dir, 'Simples.zip'), 'F.K03200.SIMPLES', simples);
  await writeZip(join(dir, 'Cnaes.zip'), 'F.K03200.CNAECSV', cnaes);
  await writeZip(join(dir, 'Municipios.zip'), 'F.K03200.MUNICCSV', municipios);
  return dir;
}
