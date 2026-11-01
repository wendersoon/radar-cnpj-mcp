/**
 * Formatting and normalization helpers for Brazilian company data.
 */

/** Removes punctuation from a CNPJ, keeping letters for alphanumeric CNPJs. */
export function normalizeCnpj(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Formats a 14-character CNPJ as 00.000.000/0000-00. */
export function formatCnpj(value: string): string {
  const cnpj = normalizeCnpj(value);
  if (cnpj.length !== 14) {
    return value;
  }
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/** Normalizes a CNAE code (e.g. "4520-0/01") to its digits ("4520001"). */
export function normalizeCnae(value: string): string {
  return value.replace(/\D/g, '');
}

/** Formats a 7-digit CNAE code as 0000-0/00. */
export function formatCnae(value: string): string {
  const code = normalizeCnae(value);
  if (code.length !== 7) {
    return value;
  }
  return `${code.slice(0, 4)}-${code.slice(4, 5)}/${code.slice(5)}`;
}

/** Formats a phone number with its area code, or returns null when empty. */
export function formatPhone(ddd: string | null, phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    return null;
  }
  const area = (ddd ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const local = `${digits.slice(0, -4)}-${digits.slice(-4)}`;
  return area ? `(${area}) ${local}` : local;
}

/** Uppercases and strips accents so names can be compared reliably. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}
