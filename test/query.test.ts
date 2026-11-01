import { describe, expect, it } from 'vitest';
import { buildWhere } from '../src/data/query.ts';
import { filterSchema } from '../src/domain/filters.ts';

const where = (input: object) => buildWhere(filterSchema.parse(input));

describe('buildWhere', () => {
  it('filters active companies by default', () => {
    expect(where({})).toEqual({ sql: 'WHERE situacao = $1', params: ['02'] });
    expect(where({ situacao: 'todas' })).toEqual({ sql: '', params: [] });
  });

  it('keeps every user value out of the SQL text', () => {
    const malicious = "x'); DROP TABLE estabelecimentos; --";
    const { sql, params } = where({ municipios: [malicious], bairros: [malicious] });
    expect(sql).not.toContain('DROP');
    expect(params).toContain("X'); DROP TABLE ESTABELECIMENTOS; --");
  });

  it('separates exact CNAE codes from prefixes', () => {
    const { sql, params } = where({ cnaes: ['4520-0/01', '47'], incluir_cnae_secundario: true });
    expect(sql).toContain('cnae_principal IN ($2)');
    expect(sql).toContain('list_has_any(cnaes_secundarios, [$2])');
    expect(sql).toContain('starts_with(cnae_principal, $3)');
    expect(params).toEqual(['02', '4520001', '47']);
  });

  it('escapes LIKE wildcards in neighborhoods', () => {
    expect(where({ bairros: ['100%_centro'] }).params).toContain('%100\\%\\_CENTRO%');
  });

  it('rejects invalid input', () => {
    expect(() => filterSchema.parse({ cnaes: ['1'] })).toThrow();
    expect(() => filterSchema.parse({ ufs: ['XX'] })).toThrow();
    expect(() => filterSchema.parse({ aberta_apos: '01/01/2025' })).toThrow();
    expect(() => filterSchema.parse({ ceps: ['13a'] })).toThrow();
  });
});
