/**
 * Code tables used by the Receita Federal open CNPJ data.
 */

export const STATUS_CODES = {
  nula: '01',
  ativa: '02',
  suspensa: '03',
  inapta: '04',
  baixada: '08',
} as const;

export type Status = keyof typeof STATUS_CODES;

export const SIZE_CODES = {
  nao_informado: '00',
  micro: '01',
  pequeno_porte: '03',
  demais: '05',
} as const;

export type Size = keyof typeof SIZE_CODES;

const STATUS_LABELS: Record<string, string> = {
  '01': 'NULA',
  '02': 'ATIVA',
  '03': 'SUSPENSA',
  '04': 'INAPTA',
  '08': 'BAIXADA',
};

const SIZE_LABELS: Record<string, string> = {
  '00': 'NAO INFORMADO',
  '01': 'MICRO EMPRESA',
  '03': 'EMPRESA DE PEQUENO PORTE',
  '05': 'DEMAIS',
};

export function statusLabel(code: string | null): string | null {
  return code === null ? null : (STATUS_LABELS[code] ?? code);
}

export function sizeLabel(code: string | null): string | null {
  return code === null ? null : (SIZE_LABELS[code] ?? code);
}

export const UFS = [
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
  'EX',
] as const;
