/**
 * Shared validator for human-supplied meal/recipe labels that must round-trip
 * through `slugifyLabel` to become a filesystem-safe id.
 *
 * Centralizes the rules so every entry point (typed reply, NL path, promotion
 * flow, prefilled add) rejects bad inputs at the boundary instead of letting
 * `slugifyLabel` throw deep inside a callback handler.
 */

import { slugifyLabel } from '../services/quick-meals-store.js';

export const LABEL_MAX_LENGTH = 100;

export type LabelValidation =
	| { ok: true; slug: string }
	| { ok: false; error: string };

export function validateLabel(raw: string): LabelValidation {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, error: 'Label cannot be empty.' };
	if (trimmed.length > LABEL_MAX_LENGTH) {
		return { ok: false, error: `Label must be ${LABEL_MAX_LENGTH} characters or fewer.` };
	}
	// Reject Telegram-markdown special characters that would either break
	// rendering or trigger send errors when interpolated as `**${label}**`.
	if (/[*_`[\]()]/.test(trimmed)) {
		return {
			ok: false,
			error: 'Label cannot contain * _ ` [ ] ( ) characters.',
		};
	}
	let slug: string;
	try {
		slug = slugifyLabel(trimmed);
	} catch {
		return {
			ok: false,
			error: 'Label must contain at least one letter or number.',
		};
	}
	return { ok: true, slug };
}
