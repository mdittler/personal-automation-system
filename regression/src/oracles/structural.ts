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
	/**
	 * Row-level multiset equality with multi-field correlation. Preserves
	 * duplicate counts AND keeps each row's fields glued together. Two actuals
	 * with the same `keyField` value can be disambiguated by additional
	 * numeric fields (e.g., two "BANANA EACH" rows with different
	 * `(totalPrice, quantity, unitPrice)` triples). A row matches an
	 * expected row when the `keyField` is byte-equal AND every numeric
	 * field declared on the expected row is within the per-field tolerance.
	 * Expected rows can omit fields the assertion shouldn't verify — only
	 * declared fields are checked.
	 *
	 * For simple `(name, totalPrice)` line-item comparisons, supply a single
	 * `valueField`. For receipt cases with quantity-multiplier lines, add
	 * `quantity` and `unitPrice` so the parser can't pass by emitting the
	 * right `totalPrice` with a wrong multiplier.
	 */
	multisetRows?: Array<{
		path: string;
		keyField: string;
		valueFields: Array<{ field: string; tolerance: number }>;
		expected: Array<Record<string, unknown>>;
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

	// 4.5. Multiset rows — N-field correlation per row, preserving duplicate
	// counts. Runs before scalars so a line-item mismatch surfaces before a
	// total mismatch (more diagnostic value for receipt cases).
	for (const ms of expectation.multisetRows ?? []) {
		const arr = getByPath(parsed, ms.path);
		if (!Array.isArray(arr)) {
			return { verdict: 'fail', details: `${ms.path} not an array` };
		}
		// Bucket expected rows by keyField value.
		const expByKey = new Map<string, Array<Record<string, unknown>>>();
		for (const row of ms.expected) {
			const k = row[ms.keyField];
			if (typeof k !== 'string') {
				return {
					verdict: 'error',
					details: `multisetRows expected row missing string key '${ms.keyField}': ${JSON.stringify(row)}`,
				};
			}
			const list = expByKey.get(k) ?? [];
			list.push(row);
			expByKey.set(k, list);
		}
		// Bucket actual rows. Skip non-object rows + rows without a string keyField.
		// Reject non-finite numeric values strictly (LLM-untrust).
		const actByKey = new Map<string, Array<Record<string, unknown>>>();
		for (const item of arr) {
			if (!item || typeof item !== 'object') continue;
			const obj = item as Record<string, unknown>;
			const k = obj[ms.keyField];
			if (typeof k !== 'string') continue;
			for (const vf of ms.valueFields) {
				const v = obj[vf.field];
				if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
					return {
						verdict: 'fail',
						details: `Multiset row at ${ms.path}: ${vf.field} not finite (got ${JSON.stringify(v)})`,
					};
				}
			}
			const list = actByKey.get(k) ?? [];
			list.push(obj);
			actByKey.set(k, list);
		}
		// Per-bucket greedy assignment. For each expected row, find the first
		// unconsumed actual row where every declared numeric field is within
		// tolerance. If found, consume; otherwise the expected row is missing.
		const missingRows: Array<Record<string, unknown>> = [];
		const extraRows: Array<Record<string, unknown>> = [];
		const allKeys = new Set<string>([...expByKey.keys(), ...actByKey.keys()]);
		for (const key of allKeys) {
			const expRows = expByKey.get(key) ?? [];
			const actRows = (actByKey.get(key) ?? []).slice(); // mutable copy
			for (const expRow of expRows) {
				const idx = actRows.findIndex((actRow) => {
					for (const vf of ms.valueFields) {
						const expVal = expRow[vf.field];
						if (expVal === undefined) continue;
						const actVal = actRow[vf.field];
						if (typeof expVal !== 'number' || typeof actVal !== 'number') return false;
						if (!Number.isFinite(expVal) || !Number.isFinite(actVal)) return false;
						if (Math.abs(expVal - actVal) > vf.tolerance) return false;
					}
					return true;
				});
				if (idx < 0) {
					missingRows.push(expRow);
				} else {
					actRows.splice(idx, 1);
				}
			}
			extraRows.push(...actRows);
		}
		if (missingRows.length > 0) {
			const fmt = missingRows.map((r) => JSON.stringify(r)).join('; ');
			return { verdict: 'fail', details: `Missing rows at ${ms.path}: ${fmt}` };
		}
		if (extraRows.length > 0) {
			const fmt = extraRows.map((r) => JSON.stringify(r)).join('; ');
			return { verdict: 'fail', details: `Hallucinated rows at ${ms.path}: ${fmt}` };
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
