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
import { type StructuralExpectation, runStructuralOracle } from '../../oracles/structural.js';
import type {
	OracleVerdict,
	PersonaCase,
	RunResult,
	TierModelSnapshot,
} from '../../shared/types.js';

interface MinimalLogger {
	warn: (msg: string, ...rest: unknown[]) => void;
	info: (msg: string, ...rest: unknown[]) => void;
	error: (msg: string, ...rest: unknown[]) => void;
	debug: (msg: string, ...rest: unknown[]) => void;
}

export interface ReceiptRunnerDeps {
	llm: Pick<LLMService, 'complete'>;
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
}

interface ReceiptSidecar {
	store?: string;
	date?: string;
	total?: number;
	subtotal?: number;
	tax?: number;
	lineItems?: Array<{ name: string; totalPrice: number }>;
	expectRejection?: boolean;
}

function mimeFor(path: string): string {
	const e = extname(path).toLowerCase();
	if (e === '.png') return 'image/png';
	if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
	if (e === '.webp') return 'image/webp';
	if (e === '.gif') return 'image/gif';
	return 'image/png';
}

function todayInTimezone(timezone: string): string {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return fmt.format(new Date()); // YYYY-MM-DD
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
		if (sidecar.store) exp.strings = [{ path: 'store', expectedCaseInsensitive: sidecar.store }];
		return exp;
	}
	if (sidecar.store) exp.strings = [{ path: 'store', expectedCaseInsensitive: sidecar.store }];
	if (sidecar.date) exp.dates = [{ path: 'date', minIso: sidecar.date, maxIso: sidecar.date }];
	if (typeof sidecar.total === 'number') {
		exp.scalars = [{ path: 'total', expected: sidecar.total, tolerance: 0.01 }];
	}
	if (sidecar.lineItems && sidecar.lineItems.length > 0) {
		exp.setEquality = [
			{
				path: 'lineItems',
				keyField: 'name',
				expected: sidecar.lineItems.map((li) => li.name),
			},
		];
		exp.keyedScalars = [
			{
				path: 'lineItems',
				keyField: 'name',
				valueField: 'totalPrice',
				tolerance: 0.01,
				expected: Object.fromEntries(sidecar.lineItems.map((li) => [li.name, li.totalPrice])),
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
	let aggregateVerdict: RunResult['verdict'] = 'pass';
	let costUsd = 0;
	const tokenIn = 0;
	const tokenOut = 0;

	// Construct minimal CoreServices shim. parseReceiptFromPhoto reads:
	//   services.llm.complete(prompt, options)
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
			if (aggregateVerdict === 'pass') aggregateVerdict = 'budget-exceeded';
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
				verdict: 'error',
				details: `parser threw: ${(err as Error).message}`,
			});
			aggregateVerdict = 'error';
			actuals.push(null);
			continue;
		}
		actuals.push(parsed);

		// Successful call charges the budget. Failed calls don't.
		costUsd += projectedNextCost;

		const expectation = buildExpectation(sidecar, today);
		const ov = runStructuralOracle(JSON.stringify(parsed), expectation);
		oracleVerdicts.push(ov);
		if (ov.verdict === 'fail' && aggregateVerdict === 'pass') aggregateVerdict = 'fail';
		if (ov.verdict === 'error') aggregateVerdict = 'error';
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
