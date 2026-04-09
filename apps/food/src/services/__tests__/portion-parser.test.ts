import { describe, it, expect } from 'vitest';
import { parsePortion } from '../portion-parser.js';

describe('parsePortion', () => {
  it('parses decimals', () => {
    expect(parsePortion('0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parsePortion('1.5')).toEqual({ ok: true, value: 1.5 });
    expect(parsePortion('2')).toEqual({ ok: true, value: 2 });
  });

  it('parses fractions', () => {
    expect(parsePortion('1/2')).toEqual({ ok: true, value: 0.5 });
    expect(parsePortion('2/3')).toEqual({ ok: true, value: 2 / 3 });
    expect(parsePortion('3/4')).toEqual({ ok: true, value: 0.75 });
  });

  it('parses unicode vulgar fractions', () => {
    expect(parsePortion('½')).toEqual({ ok: true, value: 0.5 });
    expect(parsePortion('¼')).toEqual({ ok: true, value: 0.25 });
    expect(parsePortion('¾')).toEqual({ ok: true, value: 0.75 });
  });

  it('parses keywords', () => {
    expect(parsePortion('half')).toEqual({ ok: true, value: 0.5 });
    expect(parsePortion('HALF')).toEqual({ ok: true, value: 0.5 });
    expect(parsePortion('all')).toEqual({ ok: true, value: 1 });
    expect(parsePortion('whole')).toEqual({ ok: true, value: 1 });
    expect(parsePortion('quarter')).toEqual({ ok: true, value: 0.25 });
    expect(parsePortion('a small bite')).toEqual({ ok: true, value: 0.1 });
    expect(parsePortion('a bite')).toEqual({ ok: true, value: 0.1 });
  });

  it('rejects invalid', () => {
    expect(parsePortion('').ok).toBe(false);
    expect(parsePortion('abc').ok).toBe(false);
    expect(parsePortion('-1').ok).toBe(false);
    expect(parsePortion('0').ok).toBe(false);
    expect(parsePortion('NaN').ok).toBe(false);
    expect(parsePortion('100').ok).toBe(false); // exceeds max 20
  });
});
