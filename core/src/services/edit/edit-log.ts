/**
 * EditLog — JSONL audit logger for edit operations.
 *
 * Records every edit proposal outcome (confirmed, cancelled, stale_rejected,
 * expired, no_match, access_denied, ambiguous, generation_failed) to a
 * configurable JSONL file (default: data/system/edit-log.jsonl).
 *
 * Follows the same pattern as ChangeLog: each entry is a single JSON line
 * appended atomically with appendFile (JSONL appends are append-only,
 * so appendFile is sufficient — no temp+rename needed).
 */

import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir } from '../../utils/file.js';

export type EditOutcome =
  | 'confirmed'
  | 'cancelled'
  | 'stale_rejected'
  | 'expired'
  | 'no_match'
  | 'access_denied'
  | 'ambiguous'
  | 'generation_failed';

export interface EditLogEntry {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** User who initiated the edit. */
  userId: string;
  /** Data-root-relative file path. */
  filePath: string;
  /** App that owns the file. */
  appId: string;
  /** Outcome of the edit operation. */
  outcome: EditOutcome;
  /** Human-readable description of the requested change (optional). */
  description?: string;
}

export class EditLog {
  private readonly logPath: string;
  private initialized = false;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  /**
   * Append a single JSONL entry to the log file.
   * Creates the parent directory on first call.
   */
  async append(entry: EditLogEntry): Promise<void> {
    if (!this.initialized) {
      await ensureDir(dirname(this.logPath));
      this.initialized = true;
    }

    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.logPath, line, 'utf-8');
  }
}
