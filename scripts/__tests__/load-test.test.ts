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

	it('counts LLMCostCapError log records', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await writeRecord(stream, {
			level: 50,
			err: { name: 'LLMCostCapError', scope: 'app', key: 'food' },
		});
		expect(m.getCapHits().app).toBe(1);
	});

	it('counts LLMRateLimitError log records', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await writeRecord(stream, {
			level: 50,
			err: { name: 'LLMRateLimitError', scope: 'household', key: 'hh-1' },
		});
		expect(m.getCapHits().household).toBe(1);
	});

	it('ignores other error names', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await writeRecord(stream, {
			level: 50,
			err: { name: 'SomeOtherError', scope: 'app', key: 'food' },
		});
		const hits = m.getCapHits();
		expect(hits.household + hits.app + hits.global).toBe(0);
	});

	it('handles non-JSON lines without throwing', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		// Should resolve without error
		await new Promise<void>((resolve, reject) => {
			stream.write(Buffer.from('this is not json\n'), 'utf8', (err) =>
				err ? reject(err) : resolve(),
			);
		});
		const hits = m.getCapHits();
		expect(hits.household + hits.app + hits.global).toBe(0);
	});

	it('uses err.scope for the capHit scope', async () => {
		const m = new Metrics();
		const stream = createCapCapturingTransport(m);
		await writeRecord(stream, {
			level: 50,
			err: { name: 'LLMCostCapError', scope: 'global', key: 'system' },
		});
		expect(m.getCapHits().global).toBe(1);
		expect(m.getCapHits().app).toBe(0);
		expect(m.getCapHits().household).toBe(0);
	});
});
