/**
 * Shared config-value coercion for the GUI POST handler and the <config-set> LLM tag processor.
 *
 * Returns { ok: true; coerced } on success, { ok: false; reason } on failure.
 * Numbers are rejected when non-finite — no clamping.
 */

import type { ManifestUserConfig } from '../../types/manifest.js';

export type CoerceResult =
	| { ok: true; coerced: unknown }
	| { ok: false; reason: string };

const BOOLEAN_TRUTHY = new Set(['true', '1', 'on']);
const BOOLEAN_FALSY = new Set(['false', '0', 'off']);

export function coerceUserConfigValue(entry: ManifestUserConfig, raw: unknown): CoerceResult {
	if (raw === null || raw === undefined) {
		return { ok: false, reason: `value must not be null or undefined` };
	}

	switch (entry.type) {
		case 'boolean': {
			if (typeof raw === 'boolean') return { ok: true, coerced: raw };
			if (typeof raw === 'string') {
				const lower = raw.toLowerCase();
				if (BOOLEAN_TRUTHY.has(lower)) return { ok: true, coerced: true };
				if (BOOLEAN_FALSY.has(lower)) return { ok: true, coerced: false };
			}
			return {
				ok: false,
				reason: `expected boolean-like value (true/false/on/off/1/0), got ${JSON.stringify(raw)}`,
			};
		}

		case 'number': {
			let n: number;
			if (typeof raw === 'number') {
				n = raw;
			} else if (typeof raw === 'string' && raw.trim() !== '') {
				n = Number(raw);
			} else {
				return { ok: false, reason: `expected a numeric value, got ${JSON.stringify(raw)}` };
			}
			if (!Number.isFinite(n)) {
				return { ok: false, reason: `expected finite number, got ${n}` };
			}
			return { ok: true, coerced: n };
		}

		case 'string': {
			if (typeof raw !== 'string') {
				return { ok: false, reason: `expected string, got ${typeof raw}` };
			}
			const trimmed = raw.trim();
			if (trimmed === '') {
				return { ok: false, reason: `string value must not be empty` };
			}
			return { ok: true, coerced: trimmed };
		}

		case 'select': {
			if (typeof raw !== 'string') {
				return { ok: false, reason: `expected string for select, got ${typeof raw}` };
			}
			const trimmed = raw.trim();
			const options = entry.options ?? [];
			if (options.length > 0 && !options.includes(trimmed)) {
				return {
					ok: false,
					reason: `value ${JSON.stringify(trimmed)} is not one of: ${options.map((o) => JSON.stringify(o)).join(', ')}`,
				};
			}
			if (trimmed === '') {
				return { ok: false, reason: `select value must not be empty` };
			}
			return { ok: true, coerced: trimmed };
		}

		default: {
			const _exhaustive: never = entry.type;
			return { ok: false, reason: `unknown config type: ${String(_exhaustive)}` };
		}
	}
}
