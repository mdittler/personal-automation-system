/**
 * Helpers for the dangerous-setting confirm flow.
 *
 * REQ-SETTINGS-027: phrase match MUST use constant-time comparison.
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Compare a user-submitted phrase against the expected dangerConfirmPrompt.
 *
 * The length pre-check prevents timingSafeEqual from throwing on mismatched
 * buffer sizes (which would itself leak length information). With the pre-check,
 * mismatched-length inputs are rejected in constant time.
 */
export function matchesDangerConfirmPhrase(submitted: string, expected: string): boolean {
	const a = Buffer.from(submitted, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
