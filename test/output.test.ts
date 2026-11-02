import { describe, expect, it } from 'vitest';
import { countLines } from '../src/output.ts';

describe('countLines', () => {
  it('aligns groups with proportional bars and shares', () => {
    const lines = countLines(
      [
        { grupo: 'SAO LUIS - MA', quantidade: 1068 },
        { grupo: 'IMPERATRIZ - MA', quantidade: 450 },
        { grupo: null, quantidade: 1 },
      ],
      3208,
    );
    expect(lines).toEqual([
      'SAO LUIS - MA    1.068  ████████████████████████   33,3%',
      'IMPERATRIZ - MA    450  ██████████                 14,0%',
      '(vazio)              1  █                           0,0%',
    ]);
  });
});
