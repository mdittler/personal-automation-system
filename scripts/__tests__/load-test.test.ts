import { describe, expect, it } from 'vitest';
import { Metrics, createCapCapturingTransport, quantile } from '../load-test.js';

// ---------------------------------------------------------------------------
// quantile
// ---------------------------------------------------------------------------

describe('quantile', () => {
	const samples100 = Array.from({ length: 100 }, (_, i) => i + 1); // [1..100]

	it('computes p50 from 100 sorted samples', () => {
		// nearest-rank: ceil(0.5 * 100) - 1 = 49 → samples100[49] = 50
		expect(quantile(samples100, 0.5)).toBe(50);
	});

	it('computes p95 from 100 sorted samples', () => {
		// nearest-rank: ceil(0.95 * 100) - 1 = 94 → samples100[94] = 95
		expect(quantile(samples100, 0.95)).toBe(95);
	});

	it('computes p99 from 100 sorted samples', () => {
		// nearest-rank: ceil(0.99 * 100) - 1 = 98 → samples100[98] = 99
		expect(quantile(samples100, 0.99)).toBe(99);
	});

	it('works with unsorted input', () => {
		const unsorted = [5, 1, 3, 2, 4];
		// sorted: [1,2,3,4,5]; p50 = ceil(0.5*5)-1 = 2 → 3
		expect(quantile(unsorted, 0.5)).toBe(3);
	});

	it('returns NaN for empty array', () => {
		expect(quantile([], 0.5)).toBeNaN();
	});

	it('handles single-element array', () => {
		expect(quantile([42], 0.5)).toBe(42);
		expect(quantile([42], 0.99)).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('Metrics', () => {
	it('aggregates latency per kind and overall', () => {
		const m = new Metrics();
		m.record('chatbot', 100, 'ok');
		m.record('chatbot', 200, 'ok');
		m.record('ask', 50, 'ok');

		const s = m.summary();
		expect(s.byKind.chatbot.count).toBe(2);
		expect(s.byKind.chatbot.latencies).toEqual([100, 200]);
		expect(s.byKind.ask.count).toBe(1);
		expect(s.byKind.ask.latencies).toEqual([50]);
		// p50 of [100, 200]: ceil(0.5*2)-1=0 → 100
		expect(s.byKind.chatbot.p50).toBe(100);
	});

	it('tracks per-household cost', () => {
		const m = new Metrics();
		m.recordCost('hh-1', 0.005);
		expect(m.getHouseholdCost('hh-1')).toBeCloseTo(0.005);
	});

	it('accumulates cost for same household across calls', () => {
		const m = new Metrics();
		m.recordCost('hh-1', 0.005);
		m.recordCost('hh-1', 0.003);
		expect(m.getHouseholdCost('hh-1')).toBeCloseTo(0.008);
	});

	it('tracks cap triggers keyed by scope', () => {
		const m = new Metrics();
		m.recordCapHit('household', 'hh-1');
		m.recordCapHit('household', 'hh-2');
		m.recordCapHit('app', 'food');
		m.recordCapHit('global', 'system');

		const hits = m.getCapHits();
		expect(hits.household).toBe(2);
		expect(hits.app).toBe(1);
		expect(hits.global).toBe(1);
	});

	it('summary().overall.count sums all kinds', () => {
		const m = new Metrics();
		m.record('chatbot', 100, 'ok');
		m.record('ask', 200, 'ok');
		m.record('food', 150, 'ok');

		expect(m.summary().overall.count).toBe(3);
	});

	it('summary().overall.errorCount sums all kinds', () => {
		const m = new Metrics();
		m.record('chatbot', 100, 'ok');
		m.record('chatbot', 200, 'err');
		m.record('ask', 300, 'err');

		expect(m.summary().overall.errorCount).toBe(2);
		expect(m.summary().byKind.chatbot.errorCount).toBe(1);
	});

	it('returns 0 for missing household cost', () => {
		const m = new Metrics();
		expect(m.getHouseholdCost('nonexistent')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// createCapCapturingTransport
// ---------------------------------------------------------------------------

describe('createCapCapturingTransport', () => {
	/** Write a JSON record to the transport and wait for the callback. */
	function writeRecord(
		stream: ReturnType<typeof createCapCapturingTransport>,
		record: object,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const buf = Buffer.from(JSON.stringify(record) + '\n');
			stream.write(buf, 'utf8', (err) => (err ? reject(err) : resolve()));
		});
	}

	// Each test uses the actual log record shape emitted by the guard before it
	// throws — the Router swallows the exception, so the pre-throw warn is the
	// only reliable signal (see router/index.ts:554-556).

	it('counts app rate-limit hit from LLMGuard warn record', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// LLMGuard:165 — logger.warn({ appId }, 'LLM rate limit exceeded')
		await writeRecord(stream, { level: 40, appId: 'food', msg: 'LLM rate limit exceeded' });
		expect(m.getCapHits().app).toBe(1);
	});

	it('counts household rate-limit hit from LLMGuard warn record', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// LLMGuard:177 — logger.warn({ householdId }, 'Household LLM rate limit exceeded')
		await writeRecord(stream, { level: 40, householdId: 'hh-1', msg: 'Household LLM rate limit exceeded' });
		expect(m.getCapHits().household).toBe(1);
	});

	it('counts household cost cap hit from HouseholdLLMLimiter warn record', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// HouseholdLLMLimiter:142 — logger.warn({ householdId, current, estimatedCost, cap }, 'Household monthly LLM cost cap exceeded')
		await writeRecord(stream, { level: 40, householdId: 'hh-2', current: 18, estimatedCost: 3, cap: 20, msg: 'Household monthly LLM cost cap exceeded' });
		expect(m.getCapHits().household).toBe(1);
	});

	it('counts global cost cap hit from LLMGuard warn record', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// LLMGuard:204 — logger.warn({ totalCost }, 'Global monthly LLM cost cap exceeded')
		await writeRecord(stream, { level: 40, totalCost: 50.01, msg: 'Global monthly LLM cost cap exceeded' });
		expect(m.getCapHits().global).toBe(1);
		expect(m.getCapHits().app).toBe(0);
		expect(m.getCapHits().household).toBe(0);
	});

	it('counts SystemLLMGuard household rate-limit warn (different msg suffix)', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// SystemLLMGuard:121 — 'Household LLM rate limit exceeded (system)'
		await writeRecord(stream, { level: 40, householdId: 'hh-3', msg: 'Household LLM rate limit exceeded (system)' });
		expect(m.getCapHits().household).toBe(1);
	});

	it('ignores unrelated warn/error records', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await writeRecord(stream, { level: 40, msg: 'App message handler failed', appId: 'food' });
		await writeRecord(stream, { level: 50, msg: 'Some other error occurred' });
		const hits = m.getCapHits();
		expect(hits.household + hits.app + hits.global).toBe(0);
	});

	it('handles non-JSON lines without throwing', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await new Promise<void>((resolve, reject) => {
			stream.write(Buffer.from('this is not json\n'), 'utf8', (err) =>
				err ? reject(err) : resolve(),
			);
		});
		const hits = m.getCapHits();
		expect(hits.household + hits.app + hits.global).toBe(0);
	});
});
