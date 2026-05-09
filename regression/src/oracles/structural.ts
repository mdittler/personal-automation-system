/**
 * Structural oracle (REQ-REG-004).
 *
 * AJV-based JSON schema validation + targeted assertion engine.
 * Per the regression-suite design (spec line 180): non-parseable LLM output
 * emits `verdict: 'error'`; schema violations emit `verdict: 'fail'`.
 *
 * Notes on calendar-strict dates: `Date.parse('2026-02-30')` does NOT throw —
 * it returns March 2 in UTC. We round-trip year/month/day through `Date.UTC`
 * and verify equality so calendar-impossible dates are rejected.
 *
 * LLM output is treated as untrusted per the testing-standards trust-boundary
 * rule 1: scalars require `Number.isFinite` (rejects null/NaN/Infinity).
 */

import { isCalendarStrict } from '@core/utils/temporal.js';
import AjvModule from 'ajv';
import type { OracleVerdict } from '../shared/types.js';

export interface StructuralExpectation {
	schema: object;
	strings?: Array<{ path: string; expectedCaseInsensitive: string }>;
	setEquality?: Array<{ path: string; keyField: string; expected: string[] }>;
	scalars?: Array<{ path: string; expected: number; tolerance: number }>;
	keyedScalars?: Array<{
		path: string;
		keyField: string;
		valueField: string;
		tolerance: number;
		expected: Record<string, number>;
	}>;
	dates?: Array<{ path: string; minIso: string; maxIso: string }>;
}

const ajv = new AjvModule.default({ strict: true, allErrors: true });

function getByPath(obj: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((acc, k) => {
		if (acc == null || typeof acc !== 'object') return undefined;
		return (acc as Record<string, unknown>)[k];
	}, obj);
}

export function runStructuralOracle(
	rawOutput: string,
	expectation: StructuralExpectation,
): OracleVerdict {
	// 1. JSON parsability — non-parseable is ERROR (spec line 180).
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawOutput);
	} catch (err) {
		return {
			verdict: 'error',
			details: `JSON parse failed: ${(err as Error).message}`,
		};
	}

	// 2. Schema validation.
	const validate = ajv.compile(expectation.schema);
	if (!validate(parsed)) {
		return {
			verdict: 'fail',
			details: `Schema: ${ajv.errorsText(validate.errors)}`,
		};
	}

	// 3. Strings — case-insensitive normalized equality.
	for (const s of expectation.strings ?? []) {
		const a = getByPath(parsed, s.path);
		if (typeof a !== 'string') {
			return { verdict: 'fail', details: `String ${s.path} missing or not string` };
		}
		if (a.trim().toLowerCase() !== s.expectedCaseInsensitive.toLowerCase()) {
			return {
				verdict: 'fail',
				details: `String ${s.path}: expected ~"${s.expectedCaseInsensitive}", got "${a}"`,
			};
		}
	}

	// 4. Set equality — both directions (missing + hallucinated).
	for (const set of expectation.setEquality ?? []) {
		const arr = getByPath(parsed, set.path);
		if (!Array.isArray(arr)) {
			return { verdict: 'fail', details: `${set.path} not an array` };
		}
		const actualKeys = new Set(
			arr.map((x) => (x as Record<string, unknown>)[set.keyField] as string),
		);
		const expectedKeys = new Set(set.expected);
		const missing = [...expectedKeys].filter((k) => !actualKeys.has(k));
		const extra = [...actualKeys].filter((k) => !expectedKeys.has(k));
		if (missing.length > 0) {
			return { verdict: 'fail', details: `Missing at ${set.path}: ${missing.join(', ')}` };
		}
		if (extra.length > 0) {
			return {
				verdict: 'fail',
				details: `Hallucinated at ${set.path}: ${extra.join(', ')}`,
			};
		}
	}

	// 5. Scalars — LLM-untrust: reject NaN/Infinity/non-numbers.
	for (const sc of expectation.scalars ?? []) {
		const a = getByPath(parsed, sc.path);
		if (typeof a !== 'number' || !Number.isFinite(a)) {
			return {
				verdict: 'fail',
				details: `Scalar ${sc.path} not finite (got ${JSON.stringify(a)})`,
			};
		}
		if (Math.abs(a - sc.expected) > sc.tolerance) {
			return {
				verdict: 'fail',
				details: `Scalar ${sc.path}: expected ${sc.expected}±${sc.tolerance}, got ${a}`,
			};
		}
	}

	// 6. Keyed scalars — per-item prices indexed by name.
	for (const ks of expectation.keyedScalars ?? []) {
		const arr = getByPath(parsed, ks.path);
		if (!Array.isArray(arr)) {
			return { verdict: 'fail', details: `${ks.path} not an array` };
		}
		const byKey = new Map<string, number>();
		for (const item of arr) {
			if (!item || typeof item !== 'object') continue;
			const k = (item as Record<string, unknown>)[ks.keyField];
			const v = (item as Record<string, unknown>)[ks.valueField];
			if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) {
				byKey.set(k, v);
			}
		}
		for (const [k, expected] of Object.entries(ks.expected)) {
			const actual = byKey.get(k);
			if (typeof actual !== 'number') {
				return {
					verdict: 'fail',
					details: `Keyed scalar ${ks.path}[${k}].${ks.valueField} missing`,
				};
			}
			if (Math.abs(actual - expected) > ks.tolerance) {
				return {
					verdict: 'fail',
					details: `Keyed scalar ${ks.path}[${k}].${ks.valueField}: expected ${expected}±${ks.tolerance}, got ${actual}`,
				};
			}
		}
	}

	// 7. Dates — calendar-strict + range.
	for (const d of expectation.dates ?? []) {
		// Defensive: operator misconfigured the range strings. Without this guard,
		// `Date.parse('2024-13-01')` returns NaN and the comparison `t < NaN`
		// silently evaluates to false, letting bogus ranges pass through.
		if (!isCalendarStrict(d.minIso) || !isCalendarStrict(d.maxIso)) {
			return {
				verdict: 'error',
				details: `Operator misconfigured date range: minIso=${d.minIso}, maxIso=${d.maxIso}`,
			};
		}
		const a = getByPath(parsed, d.path);
		if (typeof a !== 'string' || !isCalendarStrict(a)) {
			return {
				verdict: 'fail',
				details: `Date ${d.path} not calendar-valid YYYY-MM-DD: ${JSON.stringify(a)}`,
			};
		}
		const t = Date.parse(a);
		if (t < Date.parse(d.minIso) || t > Date.parse(d.maxIso)) {
			return {
				verdict: 'fail',
				details: `Date ${d.path} outside [${d.minIso}, ${d.maxIso}]: ${a}`,
			};
		}
	}

	return { verdict: 'pass', details: 'all assertions satisfied' };
}
