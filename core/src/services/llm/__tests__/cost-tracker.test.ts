import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeYamlFile } from '../../../utils/yaml.js';
import { CostTracker } from '../cost-tracker.js';

const logger = pino({ level: 'silent' });

describe('CostTracker', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-cost-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('creates usage file with header on first record', async () => {
		const tracker = new CostTracker(tempDir, logger);

		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 100,
			outputTokens: 50,
		});

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');
		expect(content).toContain('# LLM Usage Log');
		expect(content).toContain('| Timestamp |');
		expect(content).toContain('claude-sonnet-4-20250514');
		expect(content).toContain('100');
		expect(content).toContain('50');
	});

	it('appends entries to existing file', async () => {
		const tracker = new CostTracker(tempDir, logger);

		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 100,
			outputTokens: 50,
		});

		await tracker.record({
			model: 'claude-opus-4-6',
			inputTokens: 200,
			outputTokens: 100,
		});

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');
		expect(content).toContain('claude-sonnet-4-20250514');
		expect(content).toContain('claude-opus-4-6');
		// Header should only appear once
		const headerCount = (content.match(/# LLM Usage Log/g) ?? []).length;
		expect(headerCount).toBe(1);
	});

	it('includes app ID when provided', async () => {
		const tracker = new CostTracker(tempDir, logger);

		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 50,
			outputTokens: 25,
			appId: 'grocery',
		});

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');
		expect(content).toContain('grocery');
	});

	it('uses dash for missing app ID', async () => {
		const tracker = new CostTracker(tempDir, logger);

		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 50,
			outputTokens: 25,
		});

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');
		expect(content).toContain('| - |');
	});

	it('estimates cost correctly for Sonnet', () => {
		const tracker = new CostTracker(tempDir, logger);

		// Sonnet: $3/M input, $15/M output
		const cost = tracker.estimateCost('claude-sonnet-4-20250514', 1_000_000, 1_000_000);

		expect(cost).toBe(3.0 + 15.0);
	});

	it('estimates cost correctly for Opus', () => {
		const tracker = new CostTracker(tempDir, logger);

		// Opus: $15/M input, $75/M output
		const cost = tracker.estimateCost('claude-opus-4-6', 1_000_000, 1_000_000);

		expect(cost).toBe(15.0 + 75.0);
	});

	it('returns zero cost for unknown models', () => {
		const tracker = new CostTracker(tempDir, logger);

		const cost = tracker.estimateCost('unknown-model', 1_000_000, 1_000_000);

		// Unknown models return 0 (no pricing data)
		expect(cost).toBe(0);
	});

	it('readUsage returns empty string when file does not exist', async () => {
		const tracker = new CostTracker(tempDir, logger);

		const content = await tracker.readUsage();

		expect(content).toBe('');
	});

	it('serializes concurrent writes correctly (no duplicate headers)', async () => {
		const tracker = new CostTracker(tempDir, logger);

		// Fire 5 concurrent record() calls
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				tracker.record({
					model: 'claude-sonnet-4-20250514',
					inputTokens: (i + 1) * 10,
					outputTokens: (i + 1) * 5,
				}),
			),
		);

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');

		// Header should appear exactly once
		const headerCount = (content.match(/# LLM Usage Log/g) ?? []).length;
		expect(headerCount).toBe(1);

		// All 5 entries should be present
		const dataLines = content.split('\n').filter((line) => line.startsWith('| 20'));
		expect(dataLines).toHaveLength(5);
	});

	describe('monthly cost cache', () => {
		it('loadMonthlyCache starts fresh when no file exists', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			expect(tracker.getMonthlyAppCost('any-app')).toBe(0);
			expect(tracker.getMonthlyTotalCost()).toBe(0);
		});

		it('loadMonthlyCache loads costs from YAML file', async () => {
			const currentMonth = new Date().toISOString().slice(0, 7);
			const monthlyCostPath = join(tempDir, 'system', 'monthly-costs.yaml');

			// Pre-seed the YAML file
			await writeYamlFile(monthlyCostPath, {
				month: currentMonth,
				apps: { grocery: 1.5, echo: 0.25 },
				total: 1.75,
			});

			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			expect(tracker.getMonthlyAppCost('grocery')).toBe(1.5);
			expect(tracker.getMonthlyAppCost('echo')).toBe(0.25);
			expect(tracker.getMonthlyTotalCost()).toBe(1.75);
		});

		it('loadMonthlyCache resets when month differs', async () => {
			const monthlyCostPath = join(tempDir, 'system', 'monthly-costs.yaml');

			// Seed with a past month
			await writeYamlFile(monthlyCostPath, {
				month: '2020-01',
				apps: { grocery: 5.0 },
				total: 5.0,
			});

			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			expect(tracker.getMonthlyAppCost('grocery')).toBe(0);
			expect(tracker.getMonthlyTotalCost()).toBe(0);
		});

		it('getMonthlyAppCost returns 0 for unknown app', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			expect(tracker.getMonthlyAppCost('nonexistent')).toBe(0);
		});

		it('accumulates costs after record() calls', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
				appId: 'grocery',
			});

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 200,
				outputTokens: 100,
				appId: 'grocery',
			});

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 50,
				outputTokens: 25,
				appId: 'echo',
			});

			// Costs should accumulate per-app
			const groceryCost = tracker.getMonthlyAppCost('grocery');
			const echoCost = tracker.getMonthlyAppCost('echo');
			expect(groceryCost).toBeGreaterThan(0);
			expect(echoCost).toBeGreaterThan(0);

			// Total should be sum of all
			expect(tracker.getMonthlyTotalCost()).toBeCloseTo(groceryCost + echoCost, 10);
		});

		it('record without appId still increments total', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
			});

			expect(tracker.getMonthlyTotalCost()).toBeGreaterThan(0);
		});

		it('flush persists costs to YAML', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
				appId: 'grocery',
			});

			await tracker.flush();

			const content = await readFile(join(tempDir, 'system', 'monthly-costs.yaml'), 'utf-8');
			expect(content).toContain('grocery');
			expect(content).toContain('month');
		});

		it('maintains precision after many small additions (D5)', async () => {
			const tracker = new CostTracker(tempDir, logger);
			await tracker.loadMonthlyCache();

			// Record many small costs
			for (let i = 0; i < 100; i++) {
				await tracker.record({
					model: 'claude-haiku-4-5-20251001',
					inputTokens: 10,
					outputTokens: 5,
					appId: 'test-app',
				});
			}

			const total = tracker.getMonthlyTotalCost();
			const appCost = tracker.getMonthlyAppCost('test-app');

			// Verify no floating-point drift beyond 6 decimal places
			const totalStr = total.toString();
			const decimalPart = totalStr.split('.')[1] ?? '';
			expect(decimalPart.length).toBeLessThanOrEqual(6);

			// Total and app cost should match since all calls are from the same app
			expect(total).toBeCloseTo(appCost, 6);
		});
	});

	describe('unknown model warning (D1)', () => {
		it('logs warning when cost is 0 for non-empty model', async () => {
			const warnLogger = pino({ level: 'silent' });
			const warnSpy = vi.spyOn(warnLogger, 'warn');
			const tracker = new CostTracker(tempDir, warnLogger);

			await tracker.record({
				model: 'totally-unknown-model',
				inputTokens: 100,
				outputTokens: 50,
				provider: 'custom',
			});

			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ model: 'totally-unknown-model', provider: 'custom' }),
				expect.stringContaining('Unknown model pricing'),
			);
		});

		it('does not warn for known models', async () => {
			const warnLogger = pino({ level: 'silent' });
			const warnSpy = vi.spyOn(warnLogger, 'warn');
			const tracker = new CostTracker(tempDir, warnLogger);

			await tracker.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
			});

			expect(warnSpy).not.toHaveBeenCalledWith(
				expect.anything(),
				expect.stringContaining('Unknown model pricing'),
			);
		});
	});

	describe('getMonthlyAppCosts', () => {
		it('returns all per-app costs as a Map', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 1000,
				outputTokens: 500,
				appId: 'app-a',
			});
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 500,
				outputTokens: 200,
				appId: 'app-b',
			});

			const costs = t.getMonthlyAppCosts();
			expect(costs).toBeInstanceOf(Map);
			expect(costs.has('app-a')).toBe(true);
			expect(costs.has('app-b')).toBe(true);
			expect(costs.get('app-a')).toBeGreaterThan(0);
		});

		it('returns a defensive copy (mutations do not affect tracker)', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 1000,
				outputTokens: 500,
				appId: 'test-app',
			});

			const costs1 = t.getMonthlyAppCosts();
			costs1.set('test-app', 99999);

			const costs2 = t.getMonthlyAppCosts();
			expect(costs2.get('test-app')).not.toBe(99999);
		});
	});

	describe('per-user cost tracking', () => {
		it('accumulates costs per user after record() calls', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 500,
				outputTokens: 200,
				appId: 'chatbot',
				userId: 'user-a',
			});
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
				appId: 'chatbot',
				userId: 'user-b',
			});
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 500,
				outputTokens: 200,
				appId: 'notes',
				userId: 'user-a',
			});

			const userACost = t.getMonthlyUserCost('user-a');
			const userBCost = t.getMonthlyUserCost('user-b');
			expect(userACost).toBeGreaterThan(0);
			expect(userBCost).toBeGreaterThan(0);
			// user-a has 1000+400 tokens vs user-b's 100+50
			expect(userACost).toBeGreaterThan(userBCost);
		});

		it('getMonthlyUserCosts returns a defensive copy', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
				userId: 'user-a',
			});

			const costs1 = t.getMonthlyUserCosts();
			costs1.set('user-a', 99999);

			const costs2 = t.getMonthlyUserCosts();
			expect(costs2.get('user-a')).not.toBe(99999);
		});

		it('getMonthlyUserCost returns 0 for unknown user', async () => {
			const t = new CostTracker(tempDir, logger);
			expect(t.getMonthlyUserCost('nonexistent')).toBe(0);
		});

		it('record without userId does not add to user costs', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
			});

			const costs = t.getMonthlyUserCosts();
			expect(costs.size).toBe(0);
			expect(t.getMonthlyTotalCost()).toBeGreaterThan(0);
		});

		it('loadMonthlyCache loads per-user costs from YAML', async () => {
			const currentMonth = new Date().toISOString().slice(0, 7);
			await writeYamlFile(join(tempDir, 'system', 'monthly-costs.yaml'), {
				month: currentMonth,
				apps: { chatbot: 1.0 },
				users: { 'user-a': 0.75, 'user-b': 0.25 },
				total: 1.0,
			});

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			expect(t.getMonthlyUserCost('user-a')).toBe(0.75);
			expect(t.getMonthlyUserCost('user-b')).toBe(0.25);
			const all = t.getMonthlyUserCosts();
			expect(all.size).toBe(2);
		});

		it('flush persists per-user costs to YAML', async () => {
			const t = new CostTracker(tempDir, logger);
			await t.record({
				model: 'claude-sonnet-4-20250514',
				inputTokens: 100,
				outputTokens: 50,
				appId: 'chatbot',
				userId: 'user-a',
			});

			await t.flush();

			const content = await readFile(join(tempDir, 'system', 'monthly-costs.yaml'), 'utf-8');
			expect(content).toContain('user-a');
		});
	});
});
