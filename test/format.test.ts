import { describe, expect, it } from 'vitest';
import {
  formatCnae,
  formatCnpj,
  formatPhone,
  normalizeCnae,
  normalizeCnpj,
  normalizeText,
} from '../src/domain/format.ts';

describe('format', () => {
  it('normalizes and formats CNPJs, including alphanumeric ones', () => {
    expect(normalizeCnpj('11.111.111/0001-91')).toBe('11111111000191');
    expect(formatCnpj('11111111000191')).toBe('11.111.111/0001-91');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(formatCnpj('123')).toBe('123');
  });

  it('normalizes and formats CNAE codes', () => {
    expect(normalizeCnae('4520-0/01')).toBe('4520001');
    expect(formatCnae('4520001')).toBe('4520-0/01');
    expect(formatCnae('4520')).toBe('4520');
  });

  it('formats landlines and mobile phones', () => {
    expect(formatPhone('19', '32345678')).toBe('(19) 3234-5678');
    expect(formatPhone('019', '999887766')).toBe('(19) 99988-7766');
    expect(formatPhone(null, '32345678')).toBe('3234-5678');
    expect(formatPhone('19', '')).toBeNull();
    expect(formatPhone('19', null)).toBeNull();
  });

  it('compares text without case and accents', () => {
    expect(normalizeText('  São   José ')).toBe('SAO JOSE');
  });
});
