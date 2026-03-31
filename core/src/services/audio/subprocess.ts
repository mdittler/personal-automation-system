/**
 * Promisified child_process.execFile wrapper.
 *
 * Extracted for testability — tests can mock this single module
 * instead of dealing with child_process directly.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
