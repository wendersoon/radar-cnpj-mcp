import { z } from 'zod';
import { SIZE_CODES, STATUS_CODES, UFS } from './codes.ts';
import { normalizeCnae } from './format.ts';

const cnaeCode = z
  .string()
  .transform(normalizeCnae)
  .refine((code) => code.length >= 2 && code.length <= 7, {
    message: 'CNAE deve ter de 2 a 7 dígitos, ex.: "4520-0/01", "4520001" ou "4520"',
  });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');

/** Filters shared by every query over establishments. */
export const filterShape = {
  cnaes: z
    .array(cnaeCode)
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Códigos CNAE. Com 7 dígitos busca a subclasse exata; com menos dígitos busca por prefixo (ex.: "4520" = toda a classe). Use buscar_cnae para descobrir os códigos.',
    ),
  incluir_cnae_secundario: z
    .boolean()
    .default(false)
    .describe('Também considerar empresas que têm o CNAE como atividade secundária.'),
  ufs: z.array(z.enum(UFS)).min(1).optional().describe('Siglas das UFs, ex.: ["SP", "MG"].'),
  municipios: z
    .array(z.string().min(2))
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Nomes dos municípios, sem diferenciar maiúsculas e acentos. Combine com ufs para evitar homônimos.',
    ),
  bairros: z
    .array(z.string().min(2))
    .min(1)
    .max(100)
    .optional()
    .describe('Trechos do nome do bairro (busca parcial).'),
  ceps: z
    .array(z.string().regex(/^\d{1,8}$/, 'Use de 1 a 8 dígitos'))
    .min(1)
    .max(100)
    .optional()
    .describe('Prefixos de CEP, apenas dígitos, ex.: ["13010", "130"].'),
  situacao: z
    .enum([...(Object.keys(STATUS_CODES) as [keyof typeof STATUS_CODES]), 'todas'])
    .default('ativa')
    .describe('Situação cadastral. Padrão: ativa.'),
  aberta_apos: isoDate.optional().describe('Data de abertura a partir de (AAAA-MM-DD).'),
  aberta_antes: isoDate.optional().describe('Data de abertura até (AAAA-MM-DD).'),
  portes: z
    .array(z.enum(Object.keys(SIZE_CODES) as [keyof typeof SIZE_CODES]))
    .min(1)
    .optional()
    .describe('Porte declarado à Receita.'),
  mei: z
    .enum(['incluir', 'excluir', 'somente'])
    .default('incluir')
    .describe('Como tratar Microempreendedores Individuais (MEI).'),
  somente_matriz: z.boolean().default(false).describe('Ignorar filiais.'),
  capital_min: z.number().nonnegative().optional().describe('Capital social mínimo em reais.'),
  capital_max: z.number().nonnegative().optional().describe('Capital social máximo em reais.'),
  com_telefone: z.boolean().default(false).describe('Somente empresas com telefone cadastrado.'),
  com_email: z.boolean().default(false).describe('Somente empresas com e-mail cadastrado.'),
};

export const filterSchema = z.object(filterShape);

export type Filters = z.infer<typeof filterSchema>;

export const SORT_ORDERS = ['mais_recentes', 'mais_antigas', 'maior_capital', 'nome'] as const;

/** Parameters of a paginated search. */
export const searchShape = {
  ...filterShape,
  ordenar_por: z.enum(SORT_ORDERS).default('mais_recentes'),
  limite: z.number().int().min(1).max(500).default(50).describe('Máximo de empresas retornadas.'),
  deslocamento: z.number().int().min(0).default(0).describe('Quantas empresas pular (paginação).'),
  ocultar_contatos_mei: z
    .boolean()
    .default(false)
    .describe(
      'Ocultar telefone e e-mail de MEIs, que costumam ser os da própria pessoa física. Use ao compartilhar os resultados.',
    ),
};

export const searchSchema = z.object(searchShape);

export type SearchParams = z.infer<typeof searchSchema>;

export const GROUPINGS = [
  'uf',
  'municipio',
  'bairro',
  'cnae',
  'porte',
  'mei',
  'ano_abertura',
] as const;

export type Grouping = (typeof GROUPINGS)[number];

/** Parameters of an aggregated count. */
export const countShape = {
  ...filterShape,
  agrupar_por: z
    .enum(GROUPINGS)
    .optional()
    .describe(
      'Agrupar a contagem por esta dimensão. "porte" mostra os MEIs separados das microempresas; "mei" divide entre MEI e não MEI.',
    ),
  maximo_grupos: z.number().int().min(1).max(1000).default(50),
};

export const countSchema = z.object(countShape);

export type CountParams = z.infer<typeof countSchema>;
