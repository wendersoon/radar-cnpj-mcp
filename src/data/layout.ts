/**
 * Layout of the files published by Receita Federal in "Dados Abertos do CNPJ".
 *
 * Every file is a headerless, semicolon-separated CSV encoded in ISO-8859-1,
 * shipped inside a ZIP archive.
 */

export type FileKind = 'estabelecimentos' | 'empresas' | 'simples' | 'cnaes' | 'municipios';

export const COLUMNS: Record<FileKind, readonly string[]> = {
  estabelecimentos: [
    'cnpj_basico',
    'cnpj_ordem',
    'cnpj_dv',
    'identificador_matriz_filial',
    'nome_fantasia',
    'situacao_cadastral',
    'data_situacao_cadastral',
    'motivo_situacao_cadastral',
    'nome_cidade_exterior',
    'pais',
    'data_inicio_atividade',
    'cnae_fiscal_principal',
    'cnae_fiscal_secundaria',
    'tipo_logradouro',
    'logradouro',
    'numero',
    'complemento',
    'bairro',
    'cep',
    'uf',
    'municipio',
    'ddd_1',
    'telefone_1',
    'ddd_2',
    'telefone_2',
    'ddd_fax',
    'fax',
    'correio_eletronico',
    'situacao_especial',
    'data_situacao_especial',
  ],
  empresas: [
    'cnpj_basico',
    'razao_social',
    'natureza_juridica',
    'qualificacao_responsavel',
    'capital_social',
    'porte_empresa',
    'ente_federativo_responsavel',
  ],
  simples: [
    'cnpj_basico',
    'opcao_simples',
    'data_opcao_simples',
    'data_exclusao_simples',
    'opcao_mei',
    'data_opcao_mei',
    'data_exclusao_mei',
  ],
  cnaes: ['codigo', 'descricao'],
  municipios: ['codigo', 'descricao'],
};

const FILE_PATTERNS: Record<FileKind, RegExp> = {
  estabelecimentos: /^estabelecimentos\d*\.zip$/i,
  empresas: /^empresas\d*\.zip$/i,
  simples: /^simples\.zip$/i,
  cnaes: /^cnaes\.zip$/i,
  municipios: /^municipios\.zip$/i,
};

export const REQUIRED_KINDS: readonly FileKind[] = [
  'estabelecimentos',
  'empresas',
  'cnaes',
  'municipios',
];

/** Classifies a file name from the monthly folder, or returns null if unused. */
export function classifyFile(name: string): FileKind | null {
  for (const [kind, pattern] of Object.entries(FILE_PATTERNS)) {
    if (pattern.test(name)) {
      return kind as FileKind;
    }
  }
  return null;
}
