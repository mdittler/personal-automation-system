import { describe, expect, it } from 'vitest';
import { runTranscriptionOracle } from '../oracles/transcription.js';
import type { ReceiptTranscription, TranscriptionLineItem } from '../types/transcription.js';

interface ParsedLineItem { name: string; quantity: number; unitPrice: number | null; totalPrice: number; }
interface ParsedReceiptShape { lineItems: ParsedLineItem[]; subtotal: number | null; tax: number | null; total: number; }

const p = (over: Partial<ParsedReceiptShape>): ParsedReceiptShape =>
  ({ lineItems: [], subtotal: null, tax: null, total: 0, ...over });
const t = (over: Partial<ReceiptTranscription>): ReceiptTranscription =>
  ({ total: 0, lineItems: [], ...over });
const hi = (over: Partial<TranscriptionLineItem>): TranscriptionLineItem =>
  ({ name: '', totalPrice: 0, confidence: 'high', ...over });

describe('runTranscriptionOracle — happy path', () => {
  it('passes when parser exactly matches transcription', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'APPLE', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'APPLE', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });
  it('passes with case-insensitive name match', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'apple', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'APPLE', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });
  it('passes with whitespace-collapsed name match', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'APPLE   PIE', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'APPLE PIE', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });
});

describe('runTranscriptionOracle — missing high-confidence items (drift-resistance)', () => {
  it('fails when parser drops a single high-confidence item', () => {
    const r = runTranscriptionOracle(
      p({ total: 15, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 15, lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'B', totalPrice: 10 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/missing.*B/);
  });

  it('catches drift scenario: drop-C-inflate-B (proves PR2 catches what a drifted .expected.json would miss)', () => {
    const r = runTranscriptionOracle(
      p({
        total: 21, subtotal: 21,
        lineItems: [
          { name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
          { name: 'B', quantity: 1, unitPrice: 16, totalPrice: 16 },
        ],
      }),
      t({
        total: 21, subtotal: 21,
        lineItems: [
          hi({ name: 'A', totalPrice: 5 }),
          hi({ name: 'B', totalPrice: 6 }),
          hi({ name: 'C', totalPrice: 10 }),
        ],
      }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/missing.*C/i);
    expect(r.details).toMatch(/hallucinated.*B/i);
  });

  it('reports ALL missing high-confidence items', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({
        total: 15,
        lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'B', totalPrice: 4 }), hi({ name: 'C', totalPrice: 6 })],
      }),
    );
    expect(r.details).toMatch(/B/);
    expect(r.details).toMatch(/C/);
  });
});

describe('runTranscriptionOracle — hallucinated items', () => {
  it('fails when parser has an item not in transcription', () => {
    const r = runTranscriptionOracle(
      p({ total: 10, lineItems: [
        { name: 'APPLE', quantity: 1, unitPrice: 5, totalPrice: 5 },
        { name: 'GHOST', quantity: 1, unitPrice: 5, totalPrice: 5 },
      ]}),
      t({ total: 5, lineItems: [hi({ name: 'APPLE', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/hallucinated.*GHOST/i);
  });

  it('hallucinated item fails even when transcription has equivalent low-confidence entry IF prices differ', () => {
    const r = runTranscriptionOracle(
      p({ total: 6, lineItems: [
        { name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
        { name: 'MAYBE', quantity: 1, unitPrice: 1, totalPrice: 1 },
      ]}),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'MAYBE', totalPrice: 99, confidence: 'low' })] }),
    );
    expect(r.verdict).toBe('fail');
  });
});

describe('runTranscriptionOracle — confidence: low (optional items)', () => {
  it('passes when low-confidence item is absent from parser', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'MAYBE', totalPrice: 0.10, confidence: 'low' })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('passes when low-confidence item is present at the exact spec', () => {
    const r = runTranscriptionOracle(
      p({ total: 5.10, lineItems: [
        { name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
        { name: 'MAYBE', quantity: 1, unitPrice: 0.10, totalPrice: 0.10 },
      ]}),
      t({ total: 5.10, lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'MAYBE', totalPrice: 0.10, confidence: 'low' })] }),
    );
    expect(r.verdict).toBe('pass');
  });
});

describe('runTranscriptionOracle — multiset duplicates with find-first-satisfying-row', () => {
  it('preserves duplicate counts at same name+price', () => {
    const r = runTranscriptionOracle(
      p({ total: 4, lineItems: [
        { name: 'BANANA', quantity: 1, unitPrice: 2, totalPrice: 2 },
        { name: 'BANANA', quantity: 1, unitPrice: 2, totalPrice: 2 },
      ]}),
      t({ total: 4, lineItems: [hi({ name: 'BANANA', totalPrice: 2 }), hi({ name: 'BANANA', totalPrice: 2 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('fails when parser merges duplicates', () => {
    const r = runTranscriptionOracle(
      p({ total: 4, lineItems: [{ name: 'BANANA', quantity: 2, unitPrice: 2, totalPrice: 4 }] }),
      t({ total: 4, lineItems: [hi({ name: 'BANANA', totalPrice: 2 }), hi({ name: 'BANANA', totalPrice: 2 })] }),
    );
    expect(r.verdict).toBe('fail');
  });

  it('distinguishes same name at different prices', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [
        { name: 'BANANA', quantity: 1, unitPrice: 2, totalPrice: 2 },
        { name: 'BANANA', quantity: 1, unitPrice: 3, totalPrice: 3 },
      ]}),
      t({ total: 5, lineItems: [hi({ name: 'BANANA', totalPrice: 2 }), hi({ name: 'BANANA', totalPrice: 3 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('find-first-satisfying-row prevents order-sensitive false-pass when duplicates have different quantities', () => {
    const r = runTranscriptionOracle(
      p({ total: 4, lineItems: [
        { name: 'BANANA', quantity: 1, unitPrice: 2, totalPrice: 2 },
        { name: 'BANANA', quantity: 99, unitPrice: 1, totalPrice: 2 },
      ]}),
      t({ total: 4, lineItems: [
        hi({ name: 'BANANA', quantity: 2, unitPrice: 1, totalPrice: 2 }),
        hi({ name: 'BANANA', quantity: 1, unitPrice: 2, totalPrice: 2 }),
      ]}),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/quantity/i);
  });
});

describe('runTranscriptionOracle — quantity and unitPrice', () => {
  it('fails when quantity differs but totalPrice matches (multiplier collapse)', () => {
    const r = runTranscriptionOracle(
      p({ total: 6, lineItems: [{ name: 'A', quantity: 1, unitPrice: 6, totalPrice: 6 }] }),
      t({ total: 6, lineItems: [hi({ name: 'A', quantity: 3, unitPrice: 2, totalPrice: 6 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/quantity/);
  });

  it('skips quantity check when transcription omits it', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 99, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('skips unitPrice check when parser reports null', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: null, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('fails when unitPrice differs by more than $0.01', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5.10, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', quantity: 1, unitPrice: 5.00, totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('fail');
  });

  it('passes when unitPrice differs by exactly $0.01 (boundary)', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5.01, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', quantity: 1, unitPrice: 5.00, totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });
});

describe('runTranscriptionOracle — aggregate totals (direct money tolerance)', () => {
  it('fails when total differs by more than $0.01', () => {
    const r = runTranscriptionOracle(
      p({ total: 10.05, subtotal: 10, lineItems: [{ name: 'A', quantity: 1, unitPrice: 10, totalPrice: 10 }] }),
      t({ total: 10, subtotal: 10, lineItems: [hi({ name: 'A', totalPrice: 10 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/total/);
  });

  it('passes when total differs by exactly $0.01 (boundary)', () => {
    const r = runTranscriptionOracle(
      p({ total: 10.01, lineItems: [{ name: 'A', quantity: 1, unitPrice: 10, totalPrice: 10 }] }),
      t({ total: 10, lineItems: [hi({ name: 'A', totalPrice: 10 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('catches $0.70 vs $1.50 tax discrepancy (the Codex-flagged old tolerance hole)', () => {
    const r = runTranscriptionOracle(
      p({ total: 10.70, tax: 0.70, subtotal: 10,
        lineItems: [{ name: 'A', quantity: 1, unitPrice: 10, totalPrice: 10 }] }),
      t({ total: 11.50, tax: 1.50, subtotal: 10, lineItems: [hi({ name: 'A', totalPrice: 10 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/tax/);
  });

  it('fails when subtotal differs', () => {
    const r = runTranscriptionOracle(
      p({ total: 11, tax: 1, subtotal: 12, lineItems: [{ name: 'A', quantity: 1, unitPrice: 10, totalPrice: 10 }] }),
      t({ total: 11, tax: 1, subtotal: 10, lineItems: [hi({ name: 'A', totalPrice: 10 })] }),
    );
    expect(r.verdict).toBe('fail');
    expect(r.details).toMatch(/subtotal/);
  });

  it('skips subtotal/tax checks when transcription omits them', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, subtotal: 4.50, tax: 0.50, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('skips subtotal/tax checks when parser reports null', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, subtotal: null, tax: null, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, subtotal: 4.50, tax: 0.50, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });
});

describe('runTranscriptionOracle — error verdicts', () => {
  it('returns verdict "error" on NaN totalPrice in parsed', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: NaN }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('error');
  });
  it('returns verdict "error" on Infinity in parsed totals', () => {
    const r = runTranscriptionOracle(
      p({ total: Infinity, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('error');
  });
  it('returns verdict "error" on NaN quantity in parsed', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: NaN, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('error');
  });
});

describe('runTranscriptionOracle — security and determinism', () => {
  it('does not interpret transcription names as regex or shell', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: '$(rm -rf /)', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: '$(rm -rf /)', totalPrice: 5 })] }),
    );
    expect(r.verdict).toBe('pass');
  });

  it('produces deterministic verdict regardless of parser line-item ordering', () => {
    const trx = t({ total: 15, lineItems: [hi({ name: 'A', totalPrice: 5 }), hi({ name: 'B', totalPrice: 10 })] });
    const ordered = runTranscriptionOracle(
      p({ total: 15, lineItems: [
        { name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
        { name: 'B', quantity: 1, unitPrice: 10, totalPrice: 10 },
      ]}),
      trx,
    );
    const reversed = runTranscriptionOracle(
      p({ total: 15, lineItems: [
        { name: 'B', quantity: 1, unitPrice: 10, totalPrice: 10 },
        { name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 },
      ]}),
      trx,
    );
    expect(ordered.verdict).toBe('pass');
    expect(reversed.verdict).toBe('pass');
  });

  it('verdict shape: pass result has details string', () => {
    const r = runTranscriptionOracle(
      p({ total: 5, lineItems: [{ name: 'A', quantity: 1, unitPrice: 5, totalPrice: 5 }] }),
      t({ total: 5, lineItems: [hi({ name: 'A', totalPrice: 5 })] }),
    );
    expect(typeof r.details).toBe('string');
    expect(r.details.length).toBeGreaterThan(0);
  });
});
