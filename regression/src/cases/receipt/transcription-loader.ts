import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type {
  ReceiptTranscription,
  TranscriptionLineItem,
  TranscriptionConfidence,
} from '../../types/transcription.js';

export class TranscriptionLoadError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message} (path: ${path})`);
    this.name = 'TranscriptionLoadError';
  }
}

const MAX_TRANSCRIPTION_BYTES = 64 * 1024;
const CONFIDENCE_VALUES: ReadonlyArray<TranscriptionConfidence> = ['high', 'low'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegFinite(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

function validateLineItem(raw: unknown, idx: number, path: string): TranscriptionLineItem {
  if (raw === null || typeof raw !== 'object') {
    throw new TranscriptionLoadError(`lineItems[${idx}] is not an object`, path);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    throw new TranscriptionLoadError(`lineItems[${idx}].name missing or not a non-empty string`, path);
  }
  if (!isFiniteNumber(obj.totalPrice)) {
    throw new TranscriptionLoadError(`lineItems[${idx}].totalPrice missing or not a finite number`, path);
  }
  // Note: per-line totalPrice MAY be negative (discount lines per PR1 Batch 2). Aggregate totals may not.
  const rawConfidence = obj.confidence ?? 'high';
  if (!CONFIDENCE_VALUES.includes(rawConfidence as TranscriptionConfidence)) {
    throw new TranscriptionLoadError(`lineItems[${idx}].confidence must be 'high' or 'low'`, path);
  }
  const item: TranscriptionLineItem = {
    name: obj.name,
    totalPrice: obj.totalPrice,
    confidence: rawConfidence as TranscriptionConfidence,
  };
  if (obj.quantity !== undefined) {
    if (!isFiniteNumber(obj.quantity)) {
      throw new TranscriptionLoadError(`lineItems[${idx}].quantity not finite`, path);
    }
    item.quantity = obj.quantity;
  }
  if (obj.unitPrice === null) {
    item.unitPrice = null;
  } else if (obj.unitPrice !== undefined) {
    if (!isFiniteNumber(obj.unitPrice)) {
      throw new TranscriptionLoadError(`lineItems[${idx}].unitPrice not finite`, path);
    }
    item.unitPrice = obj.unitPrice;
  }
  return item;
}

export function loadTranscription(yamlPath: string): ReceiptTranscription {
  let stat;
  try {
    stat = statSync(yamlPath);
  } catch (err) {
    throw new TranscriptionLoadError(`cannot stat file: ${(err as Error).message}`, yamlPath);
  }
  if (stat.size > MAX_TRANSCRIPTION_BYTES) {
    throw new TranscriptionLoadError(`transcription exceeds maximum size of ${MAX_TRANSCRIPTION_BYTES} bytes`, yamlPath);
  }
  const content = readFileSync(yamlPath, 'utf8');

  const shaPath = resolve(dirname(yamlPath), basename(yamlPath, '.yaml') + '.sha256');
  let expectedSha: string | undefined;
  try {
    expectedSha = readFileSync(shaPath, 'utf8').trim();
  } catch {
    // SHA sidecar is optional in tests; committed fixtures enforce its presence via shape test.
  }
  if (expectedSha !== undefined) {
    const actualSha = createHash('sha256').update(content).digest('hex');
    if (actualSha !== expectedSha) {
      throw new TranscriptionLoadError(`sha256 mismatch: expected ${expectedSha}, got ${actualSha}`, yamlPath);
    }
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new TranscriptionLoadError(`yaml parse error: ${(err as Error).message}`, yamlPath);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new TranscriptionLoadError(`yaml root must be an object`, yamlPath);
  }
  const root = parsed as Record<string, unknown>;

  if (!isNonNegFinite(root.total)) {
    throw new TranscriptionLoadError(`total missing, not finite, or negative`, yamlPath);
  }
  if (!Array.isArray(root.lineItems) || root.lineItems.length === 0) {
    throw new TranscriptionLoadError(`lineItems must be a non-empty array`, yamlPath);
  }
  if (root.store !== undefined && typeof root.store !== 'string') {
    throw new TranscriptionLoadError(`store must be a string if present`, yamlPath);
  }
  if (root.date !== undefined && typeof root.date !== 'string') {
    throw new TranscriptionLoadError(`date must be a string if present`, yamlPath);
  }
  if (root.subtotal !== undefined && !isNonNegFinite(root.subtotal)) {
    throw new TranscriptionLoadError(`subtotal must be a non-negative finite number if present`, yamlPath);
  }
  if (root.tax !== undefined && !isNonNegFinite(root.tax)) {
    throw new TranscriptionLoadError(`tax must be a non-negative finite number if present`, yamlPath);
  }

  const lineItems = root.lineItems.map((item, idx) => validateLineItem(item, idx, yamlPath));
  const result: ReceiptTranscription = { total: root.total, lineItems };
  if (typeof root.store === 'string') result.store = root.store;
  if (typeof root.date === 'string') result.date = root.date;
  if (root.subtotal !== undefined) result.subtotal = root.subtotal as number;
  if (root.tax !== undefined) result.tax = root.tax as number;
  return result;
}
