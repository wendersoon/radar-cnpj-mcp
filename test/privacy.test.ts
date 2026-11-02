import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/data/database.ts';
import { emailWithoutCpf, withoutCpf } from '../src/data/privacy.ts';

let db: Database;

beforeAll(async () => {
  db = await Database.open(':memory:');
});

afterAll(() => db?.close());

async function clean(value: string | null): Promise<string | null> {
  const [row] = await db.all<{ v: string | null }>(`SELECT ${withoutCpf('$1::VARCHAR')} AS v`, [
    value,
  ]);
  return row?.v ?? null;
}

describe('withoutCpf', () => {
  it.each([
    ['JOAO DA SILVA 12345678900', 'JOAO DA SILVA'],
    ['JOAO DA SILVA 123.456.789-00', 'JOAO DA SILVA'],
    ['JOAO 12345678900 ME', 'JOAO ME'],
    ['JOAO 12345678900-ME', 'JOAO -ME'],
    ['JOAO - 123456789-00ME', 'JOAO - ME'],
    ['JOAO (12345678900)', 'JOAO'],
    ['JOAO 123 456 789 00', 'JOAO'],
    ['JOAO 123-456-789/00', 'JOAO'],
    ['12345678900', null],
    ['JOAO 12345678900 98765432100', 'JOAO'],
    ['RUA A 12345678900, 999, CASA', 'RUA A, 999, CASA'],
  ])('cleans %s', async (input, expected) => {
    expect(await clean(input)).toBe(expected);
  });

  it.each([
    '51.039.736 MARCIO FRIGULIO',
    '12.345.678/0001-90 COMERCIO',
    'LOJA 12345678000190',
    'FONE (11) 99999-8888',
    'CASA (AZUL) ME',
    'RUA A, 100, SALA  2',
  ])('keeps %s', async (input) => {
    expect(await clean(input)).toBe(input);
  });

  it('keeps null', async () => {
    expect(await clean(null)).toBeNull();
  });
});

describe('emailWithoutCpf', () => {
  it('drops only e-mails holding a CPF', async () => {
    const email = async (value: string) =>
      (
        await db.all<{ v: string | null }>(`SELECT ${emailWithoutCpf('$1::VARCHAR')} AS v`, [value])
      )[0]?.v;
    expect(await email('12345678900@example.com')).toBeNull();
    expect(await email('joao.123.456.789-00@example.com')).toBeNull();
    expect(await email('contato2024@example.com')).toBe('contato2024@example.com');
  });
});
