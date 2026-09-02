/**
 * Shared parser for `--model-matrix` / `--judge-model` specs.
 *
 * Single source of truth used by:
 *   - the regression CLI (`regression/src/runner/args.ts`)
 *   - the regression GUI POST handler (`core/src/gui/routes/regression.ts`)
 *
 * Tightened semantics (REQ-REG-GUI-OV-002): provider/model parts are matched
 * against explicit allow-list regexes. Shell metacharacters, traversal
 * sequences, whitespace, control characters, and HTML payloads are all
 * rejected.
 */

import type { ModelRef, ModelTier } from '../../types/llm.js';
import { MODEL_ID_PATTERN } from '../../utils/model-id.js';

export const MAX_MODEL_SPEC_CHARS = 256;
const SINGLE_REF_MAX_CHARS = Math.floor(MAX_MODEL_SPEC_CHARS / 2);

// Provider: aligned with `llm-usage.ts PROVIDER_ID_PATTERN` (alphanumeric +
// underscore + hyphen) so every provider key the rest of PAS accepts is also
// accepted here. First-char anchor prevents leading hyphens/underscores.
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

// Model: alphanumeric first char, then alphanumeric + dot / colon / hyphen /
// underscore — plus forward slash to support HuggingFace / Together-style
// namespaced ids like "meta-llama/Llama-3.3-70B-Instruct-Turbo". The `..`
// traversal sequence, "//" empty segments, and trailing "/" are rejected
// in the parseModelRef body below.
//
// Shared with `gui/routes/llm-usage.ts` and `services/system-info/index.ts`
// via `utils/model-id.ts` — a model id that can be regression-tested must also
// be assignable to a tier.
const MODEL_RE = MODEL_ID_PATTERN;

const TIER_NAMES: ReadonlySet<ModelTier> = new Set(['fast', 'standard', 'reasoning']);

export type ModelMatrix = Partial<Record<ModelTier, ModelRef>>;

/**
 * Parse a single `provider/model` spec.
 *
 * Tight semantics: rejects empty parts, illegal characters, traversal,
 * shell/HTML metacharacters, and oversized inputs.
 */
export function parseModelRef(s: string): ModelRef {
	if (typeof s !== 'string') {
		throw new TypeError('model ref must be a string');
	}
	if (s.length > SINGLE_REF_MAX_CHARS) {
		throw new RangeError(`model ref exceeds ${SINGLE_REF_MAX_CHARS} chars`);
	}
	const idx = s.indexOf('/');
	if (idx < 0) {
		throw new Error(`model ref must be provider/model (got: ${JSON.stringify(s)})`);
	}
	const provider = s.slice(0, idx);
	const model = s.slice(idx + 1);
	if (!provider) {
		throw new Error('model ref provider is empty');
	}
	if (!model) {
		throw new Error('model ref model is empty');
	}
	if (!PROVIDER_RE.test(provider)) {
		throw new Error(
			`model ref provider must match ${PROVIDER_RE.source} (got: ${JSON.stringify(provider)})`,
		);
	}
	if (!MODEL_RE.test(model)) {
		throw new Error(
			`model ref model must match ${MODEL_RE.source} (got: ${JSON.stringify(model)})`,
		);
	}
	// MODEL_RE permits `.` and `/` (for HuggingFace-style namespacing), so guard
	// against the path-traversal and empty-segment patterns those allow.
	if (model.includes('..')) {
		throw new Error('model ref must not contain ".." traversal sequence');
	}
	if (model.includes('//')) {
		throw new Error('model ref must not contain "//" (empty path segment)');
	}
	if (model.endsWith('/')) {
		throw new Error('model ref must not end with "/"');
	}
	return { provider, model };
}

/**
 * Parse a `--model-matrix=` payload.
 *
 * Forms:
 *   "fast=provider/model"                        — single named tier
 *   "fast=p/m,standard=p/m,reasoning=p/m"        — multiple named tiers
 *   "p/m"                                        — single positional (→ fast)
 *   "p/m,p/m,p/m"                                — three positional (fast, standard, reasoning)
 *   "fast=p/m,p/m"                               — mixed (REJECTED if it would conflict)
 *
 * Rejects:
 *   - empty / whitespace-only / comma-only
 *   - duplicate tier assignments
 *   - mixed positional+named that target the same tier
 *   - unknown tier names
 *   - more than 3 positional entries
 *   - any embedded `parseModelRef` violation
 */
export function parseModelMatrixValue(v: string): ModelMatrix {
	if (typeof v !== 'string') {
		throw new TypeError('model-matrix value must be a string');
	}
	if (v.length > MAX_MODEL_SPEC_CHARS) {
		throw new RangeError(`model-matrix value exceeds ${MAX_MODEL_SPEC_CHARS} chars`);
	}
	if (!v) {
		throw new Error('--model-matrix requires a value (empty string rejected)');
	}
	const rawEntries = v.split(',').map((e) => e.trim());
	const entries = rawEntries.filter(Boolean);
	if (entries.length === 0) {
		throw new Error('--model-matrix requires a value (no non-empty entries)');
	}

	const out: ModelMatrix = {};
	const POSITIONAL_ORDER: readonly ModelTier[] = ['fast', 'standard', 'reasoning'];
	let positionalIdx = 0;

	for (const entry of entries) {
		const eqIdx = entry.indexOf('=');
		let tier: ModelTier;
		let refStr: string;
		if (eqIdx > 0) {
			const tierStr = entry.slice(0, eqIdx);
			if (!TIER_NAMES.has(tierStr as ModelTier)) {
				throw new Error(
					`--model-matrix tier must be one of ${[...TIER_NAMES].join('/')} (got: ${JSON.stringify(tierStr)})`,
				);
			}
			tier = tierStr as ModelTier;
			refStr = entry.slice(eqIdx + 1);
		} else {
			tier = POSITIONAL_ORDER[positionalIdx++] as ModelTier;
			if (!tier) {
				throw new Error('--model-matrix: too many positional entries (max 3)');
			}
			refStr = entry;
		}

		if (out[tier]) {
			throw new Error(
				`--model-matrix: duplicate assignment to tier ${tier} (already set by an earlier entry — conflict)`,
			);
		}

		out[tier] = parseModelRef(refStr);
	}

	return out;
}

/**
 * Parse a `--judge-model=` payload — always lands on the standard tier.
 */
export function parseJudgeModelValue(v: string): ModelRef {
	if (typeof v !== 'string') {
		throw new TypeError('judge-model value must be a string');
	}
	if (!v) {
		throw new Error('--judge-model requires a value (empty string rejected)');
	}
	return parseModelRef(v);
}

/**
 * Type-safe normalizer for body fields read from JSON requests.
 *
 *   undefined / null  → undefined (omit)
 *   ''  / whitespace  → undefined (treat as "no override")
 *   string (≤MAX)     → trimmed string
 *   non-string        → TypeError (the POST handler maps to 400)
 *   over-MAX string   → RangeError (the POST handler maps to 400)
 */
export function normalizeOptionalModelSpec(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new TypeError('model spec must be a string');
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	if (trimmed.length > MAX_MODEL_SPEC_CHARS) {
		throw new RangeError(`model spec exceeds ${MAX_MODEL_SPEC_CHARS} chars`);
	}
	return trimmed;
}
