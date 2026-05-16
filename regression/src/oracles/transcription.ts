import type { ParsedReceipt } from '@food/services/receipt-parser.js';
import type { ReceiptLineItem } from '@food/types.js';
import { VERDICT, type Verdict } from '../shared/types.js';
import type { ReceiptTranscription, TranscriptionLineItem } from '../types/transcription.js';

export interface TranscriptionOracleResult {
  verdict: Exclude<Verdict, 'budget-exceeded'>;
  details: string;
}

// Direct money tolerances — no chain, no percentage. Operator-authored totals are exact.
const MONEY_TOLERANCE_USD = 0.01;
const QTY_TOLERANCE = 0;
const UNIT_PRICE_TOLERANCE_USD = 0.01;
const EPSILON_USD = 1e-9; // micro-epsilon for boundary fairness on USD comparisons

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function priceCents(usd: number): number {
  return Math.round(usd * 100);
}

function withinMoney(actual: number, expected: number, tolerance = MONEY_TOLERANCE_USD): boolean {
  return Math.abs(actual - expected) <= tolerance + EPSILON_USD;
}

function lineSatisfies(p: ReceiptLineItem, t: TranscriptionLineItem): { ok: boolean; reason?: string } {
  if (normalizeName(p.name) !== normalizeName(t.name)) {
    return { ok: false, reason: 'name' };
  }
  if (priceCents(p.totalPrice) !== priceCents(t.totalPrice)) {
    return { ok: false, reason: 'totalPrice' };
  }
  if (t.quantity !== undefined && Math.abs(p.quantity - t.quantity) > QTY_TOLERANCE) {
    return { ok: false, reason: 'quantity' };
  }
  if (t.unitPrice !== undefined && t.unitPrice !== null && p.unitPrice !== null) {
    if (Math.abs(p.unitPrice - (t.unitPrice as number)) > UNIT_PRICE_TOLERANCE_USD + EPSILON_USD) {
      return { ok: false, reason: 'unitPrice' };
    }
  }
  return { ok: true };
}

export function runTranscriptionOracle(
  parsed: Pick<ParsedReceipt, 'lineItems' | 'subtotal' | 'tax' | 'total'>,
  transcription: ReceiptTranscription,
): TranscriptionOracleResult {
  // ---- error preconditions ----
  if (!Number.isFinite(parsed.total)) return { verdict: VERDICT.error, details: `parsed.total not finite (${parsed.total})` };
  for (const li of parsed.lineItems) {
    if (!Number.isFinite(li.totalPrice)) return { verdict: VERDICT.error, details: `parsed totalPrice not finite for ${li.name}` };
    if (!Number.isFinite(li.quantity)) return { verdict: VERDICT.error, details: `parsed quantity not finite for ${li.name}` };
    if (li.unitPrice !== null && !Number.isFinite(li.unitPrice)) return { verdict: VERDICT.error, details: `parsed unitPrice not finite for ${li.name}` };
  }

  const failures: string[] = [];

  // find-first-satisfying-row matcher — mirrors structural.ts multisetRows.
  const trxRemaining: TranscriptionLineItem[] = [...transcription.lineItems];
  const unmatchedParsed: ReceiptLineItem[] = [];
  for (const pli of parsed.lineItems) {
    let matchedIdx = -1;
    for (let i = 0; i < trxRemaining.length; i++) {
      const candidate = trxRemaining[i];
      if (candidate === undefined) continue;
      const probe = lineSatisfies(pli, candidate);
      if (probe.ok) { matchedIdx = i; break; }
    }
    if (matchedIdx >= 0) {
      trxRemaining.splice(matchedIdx, 1);
    } else {
      unmatchedParsed.push(pli);
    }
  }

  // Diagnose unmatched parsed items.
  for (const pli of unmatchedParsed) {
    // Look for a "near miss" — same name + price, failing only on q/u — to give a precise reason.
    const near = transcription.lineItems.find(
      (t) => normalizeName(t.name) === normalizeName(pli.name) && priceCents(t.totalPrice) === priceCents(pli.totalPrice),
    );
    if (near) {
      const probe = lineSatisfies(pli, near);
      failures.push(`${probe.reason ?? 'mismatch'} mismatch for ${pli.name}: parsed q=${pli.quantity} u=${pli.unitPrice} t=${pli.totalPrice}`);
    } else {
      failures.push(`hallucinated parser item: ${pli.name} @ ${pli.totalPrice.toFixed(2)}`);
    }
  }

  // Transcription items still remaining are missing.
  for (const t of trxRemaining) {
    if (t.confidence === 'high') {
      failures.push(`missing high-confidence transcription item: ${t.name} @ ${t.totalPrice.toFixed(2)}`);
    }
    // low-confidence missing: no failure contributed.
  }

  // Aggregate totals — direct money tolerance, no chain.
  if (transcription.subtotal !== undefined && parsed.subtotal !== null) {
    if (!withinMoney(parsed.subtotal, transcription.subtotal)) {
      failures.push(`subtotal mismatch: parsed=${parsed.subtotal} expected=${transcription.subtotal}`);
    }
  }
  if (transcription.tax !== undefined && parsed.tax !== null) {
    if (!withinMoney(parsed.tax, transcription.tax)) {
      failures.push(`tax mismatch: parsed=${parsed.tax} expected=${transcription.tax}`);
    }
  }
  if (!withinMoney(parsed.total, transcription.total)) {
    failures.push(`total mismatch: parsed=${parsed.total} expected=${transcription.total}`);
  }

  if (failures.length === 0) {
    return { verdict: VERDICT.pass, details: 'transcription oracle: all checks passed' };
  }
  return { verdict: VERDICT.fail, details: failures.join('\n') };
}
