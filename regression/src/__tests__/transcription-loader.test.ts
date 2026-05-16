import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadTranscription, TranscriptionLoadError } from '../cases/receipt/transcription-loader.js';

function tempFixture(yaml: string, options?: { withSha?: 'matching' | 'mismatching' | 'missing' }): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'pr2-trx-'));
  const yamlPath = resolve(dir, 'fixture.transcription.yaml');
  writeFileSync(yamlPath, yaml, 'utf8');
  const mode = options?.withSha ?? 'missing';
  if (mode === 'matching') {
    const hash = createHash('sha256').update(yaml).digest('hex');
    writeFileSync(resolve(dir, 'fixture.transcription.sha256'), hash, 'utf8');
  } else if (mode === 'mismatching') {
    writeFileSync(resolve(dir, 'fixture.transcription.sha256'), 'a'.repeat(64), 'utf8');
  }
  return yamlPath;
}

describe('loadTranscription — happy path', () => {
  it('loads a minimal valid transcription', () => {
    const path = tempFixture(`total: 5\nlineItems:\n  - name: APPLE\n    totalPrice: 5\n    confidence: high\n`);
    const r = loadTranscription(path);
    expect(r.total).toBe(5);
    expect(r.lineItems[0]).toMatchObject({ name: 'APPLE', totalPrice: 5, confidence: 'high' });
  });

  it('defaults missing confidence to "high"', () => {
    const path = tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`);
    expect(loadTranscription(path).lineItems[0].confidence).toBe('high');
  });

  it('preserves optional store, date, subtotal, tax, quantity, unitPrice', () => {
    const yaml = `store: TJ\ndate: '2026-05-15'\nsubtotal: 4.98\ntax: 0.40\ntotal: 5.38\nlineItems:\n  - name: B\n    quantity: 2\n    unitPrice: 2.49\n    totalPrice: 4.98\n`;
    const r = loadTranscription(tempFixture(yaml));
    expect(r.store).toBe('TJ');
    expect(r.date).toBe('2026-05-15');
    expect(r.subtotal).toBe(4.98);
    expect(r.tax).toBe(0.40);
    expect(r.lineItems[0].quantity).toBe(2);
    expect(r.lineItems[0].unitPrice).toBe(2.49);
  });

  it('accepts negative totalPrice on a line item (discount line)', () => {
    const r = loadTranscription(tempFixture(
      `total: 0\nlineItems:\n  - name: DISCOUNT\n    totalPrice: -5\n  - name: A\n    totalPrice: 5\n`,
    ));
    expect(r.lineItems[0].totalPrice).toBe(-5);
  });
});

describe('loadTranscription — validation failures', () => {
  it('throws on missing total', () => {
    expect(() => loadTranscription(tempFixture(`lineItems:\n  - name: A\n    totalPrice: 1\n`)))
      .toThrow(TranscriptionLoadError);
  });

  it('throws on negative top-level total', () => {
    expect(() => loadTranscription(tempFixture(`total: -1\nlineItems:\n  - name: A\n    totalPrice: 1\n`)))
      .toThrow(/total.*non-negative|negative/);
  });

  it('throws on negative subtotal', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\nsubtotal: -1\nlineItems:\n  - name: A\n    totalPrice: 5\n`)))
      .toThrow(/subtotal/);
  });

  it('throws on negative tax', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\ntax: -1\nlineItems:\n  - name: A\n    totalPrice: 5\n`)))
      .toThrow(/tax/);
  });

  it('throws on empty lineItems', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\nlineItems: []\n`))).toThrow(/lineItems/);
  });

  it('throws on missing line-item name', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\nlineItems:\n  - totalPrice: 5\n`))).toThrow(/name/);
  });

  it('throws on non-numeric totalPrice', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: "five"\n`))).toThrow(/totalPrice/);
  });

  it('throws on invalid confidence value', () => {
    expect(() => loadTranscription(tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n    confidence: maybe\n`))).toThrow(/confidence/);
  });

  it('throws on wrong-type optional store (number instead of string)', () => {
    expect(() => loadTranscription(tempFixture(`store: 42\ntotal: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`))).toThrow(/store/);
  });

  it('throws on wrong-type optional date (number)', () => {
    expect(() => loadTranscription(tempFixture(`date: 20260515\ntotal: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`))).toThrow(/date/);
  });

  it('throws on malformed YAML', () => {
    expect(() => loadTranscription(tempFixture(`not: valid: yaml: at all: ::`))).toThrow(TranscriptionLoadError);
  });

  it('throws on file not found', () => {
    expect(() => loadTranscription('/nonexistent/path.yaml')).toThrow(TranscriptionLoadError);
  });
});

describe('loadTranscription — SHA256 fingerprint', () => {
  it('throws when sidecar SHA does not match content hash', () => {
    const path = tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`, { withSha: 'mismatching' });
    expect(() => loadTranscription(path)).toThrow(/sha256/i);
  });

  it('passes when sidecar SHA matches', () => {
    const path = tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`, { withSha: 'matching' });
    expect(() => loadTranscription(path)).not.toThrow();
  });

  it('passes when sidecar SHA file is absent (optional in temp fixtures)', () => {
    const path = tempFixture(`total: 5\nlineItems:\n  - name: A\n    totalPrice: 5\n`, { withSha: 'missing' });
    expect(() => loadTranscription(path)).not.toThrow();
  });
});

describe('loadTranscription — security', () => {
  it('rejects yaml > 64 KiB', () => {
    const big = 'total: 1\nlineItems:\n' + Array(5000).fill('  - name: A\n    totalPrice: 1\n').join('');
    expect(() => loadTranscription(tempFixture(big))).toThrow(/size/i);
  });
});
