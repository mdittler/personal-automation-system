import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ReceiptTranscription,
  TranscriptionConfidence,
  TranscriptionLineItem,
} from '../../types/transcription.js';

export class TranscriptionLoadError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message} (path: ${path})`);
    this.name = 'TranscriptionLoadError';
  }
}

const MAX_TRANSCRIPTION_BYTES = 64 * 1024;
// SHA sidecar carries a single hex digest (sha256 is 64 chars) plus optional
// trailing whitespace/newline. 128 bytes is roomy headroom; anything larger is
// treated as malformed/hostile content and rejected fail-closed.
const MAX_SHA_BYTES = 128;
const CONFIDENCE_VALUES: ReadonlyArray<TranscriptionConfidence> = ['high', 'low'];

/**
 * Capped read that avoids the TOCTOU window between `statSync` and
 * `readFileSync` — opens the file once, reads up to `max + 1` bytes, and
 * reports truncation. Caller decides whether to fail-closed or truncate.
 */
function readCapped(
  path: string,
  max: number,
): { content: string; truncated: boolean } {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, max + 1, 0);
    return {
      content: buf.slice(0, Math.min(n, max)).toString('utf8'),
      truncated: n > max,
    };
  } finally {
    closeSync(fd);
  }
}

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
  // Note: per-line totalPrice MAY be negative (discount lines). Aggregate totals may not.
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
    // `quantity` is a printed multi-unit count — it must be strictly positive.
    // Zero or negative values are nonsensical and would let a hallucinated
    // zero-quantity parser line match a transcription row. Codex round-3 #7.
    if (!isFiniteNumber(obj.quantity) || obj.quantity <= 0) {
      throw new TranscriptionLoadError(
        `lineItems[${idx}].quantity must be a positive finite number`,
        path,
      );
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

/**
 * Loads + validates a receipt transcription from a `.transcription.yaml` file.
 *
 * Trust boundary: the loader rejects relative paths and `..` segments to
 * prevent traversal, but accepts any absolute path. Callers (currently only
 * `buildCases()` in `regression/src/cases/receipt/index.ts`) are responsible
 * for ensuring the path resolves inside the regression fixtures root. Tests
 * use absolute paths into `os.tmpdir()`, which is intentional and trusted.
 *
 * Operator workflow note: editing a transcription YAML in the fixtures
 * directory requires regenerating the matching .sha256 sidecar — otherwise
 * the loader fails closed with verdict 'error'.
 */
export function loadTranscription(yamlPath: string): ReceiptTranscription {
  // Only absolute, non-traversing paths are accepted. The loader is invoked
  // from `buildCases()` and integration tests, both of which build absolute
  // paths via `resolve()` — relative inputs are always a caller bug, never
  // legitimate.
  if (!isAbsolute(yamlPath)) {
    throw new TranscriptionLoadError('transcription path must be absolute', yamlPath);
  }
  // Reject any `..` segment in the raw input. `normalize()` would collapse
  // these silently (`/tmp/../etc/passwd` → `/etc/passwd`), letting an attacker
  // escape an expected fixture root undetected — so we check the raw path
  // BEFORE normalization. Both POSIX `/` and Windows `\` separators are
  // considered so the check holds on any platform.
  if (yamlPath.split(/[/\\]/).includes('..')) {
    throw new TranscriptionLoadError(
      'transcription path contains traversal segments',
      yamlPath,
    );
  }

  // Capped read: eliminates the stat→read TOCTOU window and enforces the
  // 64 KiB ceiling without trusting `stat.size`.
  let yamlRead: { content: string; truncated: boolean };
  try {
    yamlRead = readCapped(yamlPath, MAX_TRANSCRIPTION_BYTES);
  } catch (err) {
    throw new TranscriptionLoadError(`cannot read file: ${(err as Error).message}`, yamlPath);
  }
  if (yamlRead.truncated) {
    throw new TranscriptionLoadError(
      `transcription exceeds maximum size of ${MAX_TRANSCRIPTION_BYTES} bytes`,
      yamlPath,
    );
  }
  const content = yamlRead.content;

  const shaPath = resolve(dirname(yamlPath), `${basename(yamlPath, '.yaml')}.sha256`);
  let expectedSha: string | undefined;
  try {
    const shaRead = readCapped(shaPath, MAX_SHA_BYTES);
    if (shaRead.truncated) {
      throw new TranscriptionLoadError(
        `sha256 sidecar exceeds maximum size of ${MAX_SHA_BYTES} bytes`,
        shaPath,
      );
    }
    expectedSha = shaRead.content.trim();
  } catch (err) {
    // The TranscriptionLoadError from the truncated branch must propagate;
    // ENOENT (sidecar absent) is acceptable and treated as "no SHA assertion".
    if (err instanceof TranscriptionLoadError) {
      throw err;
    }
    // SHA sidecar is optional in tests; committed fixtures enforce its
    // presence via the shape test.
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
    throw new TranscriptionLoadError('yaml root must be an object', yamlPath);
  }
  const root = parsed as Record<string, unknown>;

  if (!isNonNegFinite(root.total)) {
    throw new TranscriptionLoadError('total missing, not finite, or negative', yamlPath);
  }
  if (!Array.isArray(root.lineItems) || root.lineItems.length === 0) {
    throw new TranscriptionLoadError('lineItems must be a non-empty array', yamlPath);
  }
  if (root.store !== undefined && typeof root.store !== 'string') {
    throw new TranscriptionLoadError('store must be a string if present', yamlPath);
  }
  if (root.date !== undefined && typeof root.date !== 'string') {
    throw new TranscriptionLoadError('date must be a string if present', yamlPath);
  }
  if (root.subtotal !== undefined && !isNonNegFinite(root.subtotal)) {
    throw new TranscriptionLoadError('subtotal must be a non-negative finite number if present', yamlPath);
  }
  if (root.tax !== undefined && !isNonNegFinite(root.tax)) {
    throw new TranscriptionLoadError('tax must be a non-negative finite number if present', yamlPath);
  }

  const lineItems = root.lineItems.map((item, idx) => validateLineItem(item, idx, yamlPath));
  const result: ReceiptTranscription = { total: root.total, lineItems };
  if (typeof root.store === 'string') result.store = root.store;
  if (typeof root.date === 'string') result.date = root.date;
  if (root.subtotal !== undefined) result.subtotal = root.subtotal as number;
  if (root.tax !== undefined) result.tax = root.tax as number;
  return result;
}
