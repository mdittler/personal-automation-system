/**
 * Receipt runner — calls the production `parseReceiptFromPhoto` extractor
 * from `apps/food/src/services/receipt-parser.ts`. The runner does NOT
 * duplicate the prompt: a regression in the food prompt must propagate
 * here so the suite catches it.
 *
 * Budget enforcement (REQ-REG-008): each per-input dispatch is gated by a
 * pre-charge check. If the next call's estimated cost would push the
 * accumulated cost past `caseBudgetUsd`, the runner aborts before the LLM
 * is invoked and returns `verdict: 'budget-exceeded'`.
 *
 * Trust-boundary notes:
 * - The parser is the trust boundary for LLM output (untrusted JSON →
 *   validated `ParsedReceipt`). The runner consumes the validated result.
 * - For `expectRejection: true` sidecars, the runner asserts the parser's
 *   fallback to today + retention of `rawExtractedDate`.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { CoreServices } from '@core/types/app-module.js';
import type { LLMService } from '@core/types/llm.js';
import { parseReceiptFromPhoto } from '@food/services/receipt-parser.js';
import { loadTranscription } from '../../cases/receipt/transcription-loader.js';
import { runTranscriptionOracle } from '../../oracles/transcription.js';
import { type StructuralExpectation, runStructuralOracle } from '../../oracles/structural.js';
import { todayInTimezone } from '../../shared/cache-key.js';
import {
	ORACLE_LABEL,
	type OracleVerdict,
	type PersonaCase,
	type RunResult,
	type TierModelSnapshot,
	VERDICT,
	type Verdict,
} from '../../shared/types.js';

/**
 * Combine two verdicts with set-based AND semantics:
 *   any `error` → `error`; else any `fail` → `fail`; else pass-through.
 * Used to fold per-input oracle verdicts into the case aggregate without
 * demoting stronger verdicts.
 */
export function combineVerdicts(prev: Verdict, next: Verdict): Verdict {
	if (prev === VERDICT.error || next === VERDICT.error) return VERDICT.error;
	if (prev === VERDICT.fail || next === VERDICT.fail) return VERDICT.fail;
	return prev;
}

interface MinimalLogger {
	warn: (msg: string, ...rest: unknown[]) => void;
	info: (msg: string, ...rest: unknown[]) => void;
	error: (msg: string, ...rest: unknown[]) => void;
	debug: (msg: string, ...rest: unknown[]) => void;
}

export interface ReceiptRunnerDeps {
	// The production parseReceiptFromPhoto uses `completeWithMeta` so it can
	// detect max-token truncation. The regression shim must expose the same
	// method. `complete` is also kept because intermediate adapters in some
	// stubs still rely on it.
	llm: Pick<LLMService, 'complete' | 'completeWithMeta'>;
	logger: MinimalLogger;
	timezone: string;
	modelIds: TierModelSnapshot;
	cacheKey: string;
	caseBudgetUsd: number;
	/**
	 * Estimate USD for the next LLM call. Real wiring will derive this from
	 * `CostTracker.estimateCost`. Unit tests inject a stub.
	 */
	estimateUsd: (call: { tokenIn: number; tokenOut: number }) => number;
}

interface ReceiptPayload {
	photoFixture: string;
	sidecarFixture: string;
	/**
	 * Optional path to a YAML transcription file (with sibling `.sha256`).
	 * When present AND `sidecar.expectRejection` is NOT true, the runner
	 * invokes the transcription oracle in addition to the structural oracle.
	 * Fail-closed: missing files and SHA mismatches produce
	 * `verdict: 'error'` on the transcription verdict (and aggregate to case
	 * verdict `'error'`).
	 */
	transcriptionFixture?: string;
}

interface ReceiptSidecar {
	store?: string;
	date?: string;
	total?: number;
	subtotal?: number;
	tax?: number;
	/**
	 * Per-line ground truth. The multiset oracle preserves duplicate counts
	 * by comparing `(name, totalPrice)` tuples — two entries with the same
	 * name and same price match two such actuals; two entries with the same
	 * name and different prices are disambiguated by value. `quantity` and
	 * `unitPrice` are optional; when present, they become additional
	 * multiset assertions on `(name, quantity)` and `(name, unitPrice)`.
	 */
	lineItems?: Array<{
		name: string;
		totalPrice: number;
		quantity?: number;
		unitPrice?: number | null;
	}>;
	expectRejection?: boolean;
	/**
	 * The exact date string the parser is expected to have extracted from the
	 * photo before `isValidReceiptDate` rejected it. When set (in
	 * `expectRejection: true` sidecars), `buildExpectation` adds a string
	 * assertion on the parsed `rawExtractedDate` field — proving the parser
	 * preserved the original LLM extraction for audit.
	 */
	rejectedDate?: string;
}

function mimeFor(path: string): string {
	const e = extname(path).toLowerCase();
	if (e === '.png') return 'image/png';
	if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
	if (e === '.webp') return 'image/webp';
	if (e === '.gif') return 'image/gif';
	return 'image/png';
}

function buildExpectation(sidecar: ReceiptSidecar, today: string): StructuralExpectation {
	const exp: StructuralExpectation = {
		schema: {
			type: 'object',
			required: ['store', 'date', 'lineItems', 'total'],
			properties: {
				store: { type: 'string' },
				date: { type: 'string' },
				lineItems: { type: 'array' },
				total: { type: 'number' },
			},
		},
	};
	if (sidecar.expectRejection) {
		// The parser overwrites the rejected date to today; assert that.
		exp.dates = [{ path: 'date', minIso: today, maxIso: today }];
		const strings: NonNullable<StructuralExpectation['strings']> = [];
		if (sidecar.store) {
			strings.push({ path: 'store', expectedCaseInsensitive: sidecar.store });
		}
		if (sidecar.rejectedDate) {
			// Prove the parser preserved the LLM's original date extraction
			// in `rawExtractedDate` for audit.
			strings.push({
				path: 'rawExtractedDate',
				expectedCaseInsensitive: sidecar.rejectedDate,
			});
		}
		if (strings.length > 0) exp.strings = strings;
		return exp;
	}
	if (sidecar.store) exp.strings = [{ path: 'store', expectedCaseInsensitive: sidecar.store }];
	if (sidecar.date) exp.dates = [{ path: 'date', minIso: sidecar.date, maxIso: sidecar.date }];
	// Assert subtotal/tax when the sidecar provides them, not just total.
	// The receipt-parser's integrity-check warnings catch some drift via
	// `verification_warnings`, but the regression suite is where ground-truth
	// comparison happens.
	const scalars: NonNullable<StructuralExpectation['scalars']> = [];
	if (typeof sidecar.total === 'number') {
		scalars.push({ path: 'total', expected: sidecar.total, tolerance: 0.01 });
	}
	if (typeof sidecar.subtotal === 'number') {
		scalars.push({ path: 'subtotal', expected: sidecar.subtotal, tolerance: 0.01 });
	}
	if (typeof sidecar.tax === 'number') {
		scalars.push({ path: 'tax', expected: sidecar.tax, tolerance: 0.01 });
	}
	if (scalars.length > 0) exp.scalars = scalars;
	if (sidecar.lineItems && sidecar.lineItems.length > 0) {
		// Row-level multiset: keeps each line's (totalPrice, [quantity], [unitPrice])
		// fields glued together so the parser can't pass by emitting the right
		// totalPrice with a wrong multiplier. `quantity`/`unitPrice` are only
		// added to the valueFields list when at least one sidecar row declares
		// them; expected rows that omit a field skip that field's check.
		const valueFields: NonNullable<StructuralExpectation['multisetRows']>[0]['valueFields'] = [
			{ field: 'totalPrice', tolerance: 0.01 },
		];
		if (sidecar.lineItems.some((li) => typeof li.quantity === 'number')) {
			valueFields.push({ field: 'quantity', tolerance: 0.001 });
		}
		if (sidecar.lineItems.some((li) => typeof li.unitPrice === 'number')) {
			valueFields.push({ field: 'unitPrice', tolerance: 0.01 });
		}
		exp.multisetRows = [
			{
				path: 'lineItems',
				keyField: 'name',
				valueFields,
				expected: sidecar.lineItems.map((li) => {
					const row: Record<string, unknown> = { name: li.name, totalPrice: li.totalPrice };
					if (typeof li.quantity === 'number') row.quantity = li.quantity;
					if (typeof li.unitPrice === 'number') row.unitPrice = li.unitPrice;
					return row;
				}),
			},
		];
	}
	return exp;
}

export async function runReceiptCase(c: PersonaCase, deps: ReceiptRunnerDeps): Promise<RunResult> {
	const start = Date.now();
	const today = todayInTimezone(deps.timezone);
	const actuals: unknown[] = [];
	const oracleVerdicts: OracleVerdict[] = [];
	let aggregateVerdict: RunResult['verdict'] = VERDICT.pass;
	let costUsd = 0;
	const tokenIn = 0;
	const tokenOut = 0;

	// Construct minimal CoreServices shim. parseReceiptFromPhoto reads:
	//   services.llm.completeWithMeta(prompt, options)
	//   services.timezone
	//   services.logger.warn(...)
	// Other CoreServices fields are unused here; the cast is intentional.
	const services = {
		llm: deps.llm,
		logger: deps.logger,
		timezone: deps.timezone,
	} as unknown as CoreServices;

	for (const input of c.inputs) {
		// Pre-charge gate: abort BEFORE the next call if it would cross the
		// budget. The estimate is conservative (no usage data is available
		// until after the call returns), so the gate prevents over-spend
		// rather than refunding it.
		const projectedNextCost = deps.estimateUsd({ tokenIn: 0, tokenOut: 0 });
		if (costUsd + projectedNextCost > deps.caseBudgetUsd) {
			if (aggregateVerdict === VERDICT.pass) aggregateVerdict = VERDICT.budgetExceeded;
			break;
		}

		const payload = input.payload as ReceiptPayload;
		const photoBuf = await readFile(payload.photoFixture);
		const sidecarText = await readFile(payload.sidecarFixture, 'utf8');
		const sidecar = JSON.parse(sidecarText) as ReceiptSidecar;

		let parsed: Awaited<ReturnType<typeof parseReceiptFromPhoto>>;
		try {
			parsed = await parseReceiptFromPhoto(services, photoBuf, mimeFor(payload.photoFixture));
		} catch (err) {
			oracleVerdicts.push({
				label: ORACLE_LABEL.structural,
				verdict: VERDICT.error,
				details: `parser threw: ${(err as Error).message}`,
			});
			aggregateVerdict = VERDICT.error;
			actuals.push(null);
			continue;
		}
		actuals.push(parsed);

		// Successful call charges the budget. Failed calls don't.
		costUsd += projectedNextCost;

		// Collect the verdicts produced for THIS input (structural always,
		// transcription conditionally) so the aggregation pass can apply
		// set-based AND without revisiting verdicts from prior inputs.
		const perInputVerdicts: OracleVerdict[] = [];

		// ---- Structural oracle: sidecar-based ground truth. ----
		const expectation = buildExpectation(sidecar, today);
		const structuralOv = runStructuralOracle(JSON.stringify(parsed), expectation);
		const structuralLabeled: OracleVerdict = { ...structuralOv, label: ORACLE_LABEL.structural };
		oracleVerdicts.push(structuralLabeled);
		perInputVerdicts.push(structuralLabeled);

		// ---- Transcription oracle: operator-authored ground truth for
		// receipt line items. Skips when `sidecar.expectRejection` is true
		// (the parser exercised its rejection branch — no useful transcription
		// comparison) or when the case doesn't carry a transcription fixture
		// path. Fail-closed: a load error (missing file, SHA mismatch,
		// malformed YAML) produces verdict='error'.
		const trxPath = payload.transcriptionFixture;
		if (!sidecar.expectRejection && typeof trxPath === 'string' && trxPath.length > 0) {
			let trxLabeled: OracleVerdict;
			try {
				const trx = loadTranscription(trxPath);
				const trxOv = runTranscriptionOracle(parsed, trx);
				trxLabeled = {
					label: ORACLE_LABEL.transcription,
					verdict: trxOv.verdict,
					details: trxOv.details,
				};
			} catch (err) {
				trxLabeled = {
					label: ORACLE_LABEL.transcription,
					verdict: VERDICT.error,
					details: `transcription load failed: ${(err as Error).message}`,
				};
			}
			oracleVerdicts.push(trxLabeled);
			perInputVerdicts.push(trxLabeled);
		}

		// ---- Set-based aggregation for THIS input only. ----
		// `aggregateVerdict` is monotonic: never demote `error` to `fail` or
		// `fail` to `pass`. Explicit `Verdict` generic on `.reduce` prevents
		// the accumulator from being narrowed to the initial value's literal
		// type (`'pass'` or `'pass' | 'error'`), which would reject the `'fail'`
		// branch of `combineVerdicts`'s return type.
		aggregateVerdict = perInputVerdicts.reduce<Verdict>(
			(acc, ov) => combineVerdicts(acc, ov.verdict),
			aggregateVerdict,
		);
	}

	return {
		caseId: c.id,
		cacheKey: deps.cacheKey,
		source: 'fresh',
		verdict: aggregateVerdict,
		inputs: c.inputs,
		actuals,
		oracleVerdicts,
		tokenCounts: { input: tokenIn, output: tokenOut },
		costUsd,
		modelIds: deps.modelIds,
		evaluatedTier: 'standard',
		timestamp: new Date().toISOString(),
		durationMs: Date.now() - start,
	};
}
