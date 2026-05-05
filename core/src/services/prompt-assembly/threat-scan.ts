/**
 * Threat-scan module for context store writes.
 *
 * Scans content for known injection/XSS patterns before persisting to disk.
 * Structurally anchored patterns are used to minimise false positives on normal
 * prose that merely references HTML concepts.
 *
 * NOTE: The threat log MUST NOT include the matched substring — only the
 * pattern name and userId are logged to prevent PII leakage in log files.
 */

export interface ThreatHit {
	hit: true;
	/** The symbolic name of the matched pattern (e.g. "script-tag"). */
	pattern: string;
}

export interface NoThreat {
	hit: false;
}

export type ThreatScanResult = ThreatHit | NoThreat;

/**
 * Named threat patterns.
 *
 * Order matters: `scanForThreats` returns the first match.
 */
export const THREAT_PATTERNS: { name: string; re: RegExp }[] = [
	{ name: 'script-tag', re: /<script\b[^>]*>/i },
	{ name: 'iframe-tag', re: /<iframe\b/i },
	{ name: 'svg-onload', re: /<svg\b[^>]*\bonload\s*=/i },
	{ name: 'js-url', re: /\bjavascript:[a-z%/]/i },
	{ name: 'data-html-url', re: /\bdata:text\/html\b/i },
	{
		name: 'prompt-injection-ignore',
		re: /^[\s>]*(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+instructions?/im,
	},
	{
		name: 'prompt-injection-roleplay',
		re: /^[\s>]*you\s+are\s+(?:now\s+)?(?:a\s+|an\s+|the\s+)?(?:unrestricted|jailbroken|developer\s+mode|admin\s+mode)/im,
	},
];

/**
 * Scan `content` against all threat patterns.
 *
 * Returns the first match found (by pattern order), or `{ hit: false }` if
 * none match. Only the pattern NAME is returned — never the matched substring.
 */
export function scanForThreats(content: string): ThreatScanResult {
	for (const { name, re } of THREAT_PATTERNS) {
		if (re.test(content)) {
			return { hit: true, pattern: name };
		}
	}
	return { hit: false };
}
