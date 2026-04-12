import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

	it('returns zero cost for unknown ollama models', () => {
		const tracker = new CostTracker(tempDir, logger);

		const cost = tracker.estimateCost('some-local-model', 1_000_000, 1_000_000, 'ollama');

		// Ollama is locally hosted — always free
		expect(cost).toBe(0);
	});

	it('returns conservative fallback cost for unknown remote models', () => {
		const tracker = new CostTracker(tempDir, logger);

		const cost = tracker.estimateCost('unknown-remote-model', 1_000_000, 1_000_000);

		// Unknown remote models use DEFAULT_REMOTE_PRICING, not $0
		expect(cost).toBeGreaterThan(0);
	});

	it('readUsage returns empty string when file does not exist', async () => {
		const tracker = new CostTracker(tempDir, logger);

		const content = await tracker.readUsage();

		expect(content).toBe('');
	});

	it('writeQueue recovers after a failed write', async () => {
		const tracker = new CostTracker(tempDir, logger);

		// Create `tempDir/system` as a FILE to block the directory path
		await writeFile(join(tempDir, 'system'), 'blocking-file', 'utf-8');

		// First record fails internally (record() swallows errors via appendEntry)
		// Use a distinct model name so we can assert it is absent from the recovered file
		await tracker.record({
			model: 'claude-opus-4-6',
			inputTokens: 100,
			outputTokens: 50,
		});

		// Remove the blocking file and create the directory properly
		const { unlink } = await import('node:fs/promises');
		await unlink(join(tempDir, 'system'));
		await mkdir(join(tempDir, 'system'), { recursive: true });

		// Second record should succeed even though first failed
		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 200,
			outputTokens: 100,
		});

		const content = await readFile(join(tempDir, 'system', 'llm-usage.md'), 'utf-8');
		expect(content).toContain('# LLM Usage Log');
		expect(content).toContain('claude-sonnet-4-20250514');
		// The first (failed) record's data must NOT appear — the queue recovered cleanly
		expect(content).not.toContain('claude-opus-4-6');
	});

	it('writeQueue .then(fn,fn) design: in-memory cost cache is updated even when file write fails', async () => {
		// CostTracker.appendEntry() uses a write queue with this shape:
		//   const p = this.writeQueue.then(() => doAppendEntry(e), () => doAppendEntry(e));
		//   this.writeQueue = p.then(() => {}, () => {});  // tail always resolves
		//
		// Key design property: updateMonthlyCache() runs BEFORE appendEntry() in record().
		// So even when the file write fails, the in-memory monthly cost cache is updated.
		// This means LLMGuard cost caps still accumulate correctly even under I/O failures.
		//
		// Note: vi.spyOn on node:fs/promises is not possible in ESM (namespace is not
		// configurable), so we inject the failure via filesystem structure.

		const tracker = new CostTracker(tempDir, logger);
		await tracker.loadMonthlyCache();

		// Block system dir with a file to cause doAppendEntry to fail
		await writeFile(join(tempDir, 'system'), 'blocking-file', 'utf-8');

		// record() fails at file write level, but in-memory cost cache must still be updated
		await tracker.record({
			model: 'claude-sonnet-4-20250514',
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			appId: 'test-app',
		});

		// In-memory cache was updated despite the file write failure
		expect(tracker.getMonthlyAppCost('test-app')).toBeGreaterThan(0);
		expect(tracker.getMonthlyTotalCost()).toBeGreaterThan(0);
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

	describe('unknown model warning (D1/F10)', () => {
		it('logs warning with fallback cost for unknown remote model', async () => {
			const warnLogger = pino({ level: 'silent' });
			const warnSpy = vi.spyOn(warnLogger, 'warn');
			const tracker = new CostTracker(tempDir, warnLogger);

			await tracker.record({
				model: 'totally-unknown-model',
				inputTokens: 100,
				outputTokens: 50,
				provider: 'custom',
				providerType: 'openai-compatible',
			});

			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					model: 'totally-unknown-model',
					provider: 'custom',
					fallbackCost: expect.any(Number),
				}),
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

		it('does not warn for ollama models (ollama is free by design)', async () => {
			const warnLogger = pino({ level: 'silent' });
			const warnSpy = vi.spyOn(warnLogger, 'warn');
			const tracker = new CostTracker(tempDir, warnLogger);

			await tracker.record({
				model: 'llama3.2:3b',
				inputTokens: 100,
				outputTokens: 50,
				provider: 'ollama',
				providerType: 'ollama',
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

	describe('rebuildFromLog (F13)', () => {
		const currentMonth = new Date().toISOString().slice(0, 7);

		/** Write a minimal valid usage log with given table rows. */
		async function writeUsageLog(systemDir: string, rows: string[]): Promise<void> {
			await mkdir(systemDir, { recursive: true });
			const header = [
				'# LLM Usage Log',
				'',
				'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User |',
				'|-----------|----------|-------|-------------|---------------|----------|-----|------|',
				'',
			].join('\n');
			const body = rows.join('\n') + '\n';
			await writeFile(join(systemDir, 'llm-usage.md'), header + body, 'utf-8');
		}

		it('rebuilds totals from usage log when YAML cache is missing', async () => {
			const systemDir = join(tempDir, 'system');
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-10T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 1000 | 500 | 0.010500 | chatbot | user-a |`,
				`| ${currentMonth}-10T13:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 500 | 200 | 0.004500 | food | user-b |`,
			]);
			// No monthly-costs.yaml

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.015, 5);
			expect(t.getMonthlyAppCost('chatbot')).toBeCloseTo(0.0105, 6);
			expect(t.getMonthlyAppCost('food')).toBeCloseTo(0.0045, 6);
			expect(t.getMonthlyUserCost('user-a')).toBeCloseTo(0.0105, 6);
			expect(t.getMonthlyUserCost('user-b')).toBeCloseTo(0.0045, 6);
		});

		it('rebuilds when YAML cache is corrupt/malformed', async () => {
			const systemDir = join(tempDir, 'system');
			await mkdir(systemDir, { recursive: true });
			await writeFile(join(systemDir, 'monthly-costs.yaml'), '{{{{ bad yaml: [[[', 'utf-8');
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-11T09:00:00.000Z | google | gemini-2.0-flash | 2000 | 1000 | 0.000600 | notes | user-c |`,
			]);

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.0006, 6);
			expect(t.getMonthlyAppCost('notes')).toBeCloseTo(0.0006, 6);
			expect(t.getMonthlyUserCost('user-c')).toBeCloseTo(0.0006, 6);
		});

		it('rebuilds when YAML cache is from a different (old) month', async () => {
			const systemDir = join(tempDir, 'system');
			await mkdir(systemDir, { recursive: true });
			// Write an old-month cache
			await writeYamlFile(join(systemDir, 'monthly-costs.yaml'), {
				month: '2020-01',
				apps: { chatbot: 99.0 },
				users: {},
				total: 99.0,
			});
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-05T10:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 500 | 200 | 0.003000 | chatbot | - |`,
			]);

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			// Should use current-month log data, NOT the old $99 from the stale cache
			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.003, 6);
			expect(t.getMonthlyAppCost('chatbot')).toBeCloseTo(0.003, 6);
		});

		it('only includes current-month entries during rebuild', async () => {
			const systemDir = join(tempDir, 'system');
			const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1))
				.toISOString()
				.slice(0, 7);

			await writeUsageLog(systemDir, [
				`| ${lastMonth}-15T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 1000 | 500 | 5.000000 | chatbot | user-a |`,
				`| ${currentMonth}-10T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 100 | 50 | 0.001050 | chatbot | user-a |`,
			]);

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			// Only the current-month entry should be counted
			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.00105, 6);
		});

		it('handles empty usage log gracefully (starts fresh)', async () => {
			const systemDir = join(tempDir, 'system');
			await mkdir(systemDir, { recursive: true });
			await writeFile(join(systemDir, 'llm-usage.md'), '', 'utf-8');

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			expect(t.getMonthlyTotalCost()).toBe(0);
			expect(t.getMonthlyAppCosts().size).toBe(0);
		});

		it('starts fresh on clean install (no files at all)', async () => {
			// tempDir exists but no 'system' subdirectory — clean install
			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			expect(t.getMonthlyTotalCost()).toBe(0);
		});

		it('persists rebuilt cache to YAML after rebuild', async () => {
			const systemDir = join(tempDir, 'system');
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-10T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 1000 | 500 | 0.010500 | chatbot | - |`,
			]);

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();
			await t.flush();

			const raw = await readFile(join(systemDir, 'monthly-costs.yaml'), 'utf-8');
			expect(raw).toContain(currentMonth);
			expect(raw).toContain('chatbot');
		});

		it('is idempotent — repeated loadMonthlyCache calls do not double-count', async () => {
			const systemDir = join(tempDir, 'system');
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-10T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 1000 | 500 | 0.010500 | chatbot | user-a |`,
			]);
			// No YAML cache — will rebuild from log both times

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache(); // first rebuild
			await t.loadMonthlyCache(); // second call — should reset, not double-count

			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.0105, 6);
			expect(t.getMonthlyAppCost('chatbot')).toBeCloseTo(0.0105, 6);
		});

		it('ignores malformed log lines (missing columns, non-numeric cost)', async () => {
			const systemDir = join(tempDir, 'system');
			await writeUsageLog(systemDir, [
				`| ${currentMonth}-10T12:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 1000 | 500 | 0.010500 | chatbot | user-a |`,
				`| ${currentMonth}-10T13:00:00.000Z | oops malformed line without correct columns |`,
				`| ${currentMonth}-10T14:00:00.000Z | anthropic | model | 100 | 50 | not-a-number | app | user |`,
				`| ${currentMonth}-10T15:00:00.000Z | anthropic | claude-sonnet-4-20250514 | 200 | 100 | 0.001000 | notes | - |`,
			]);

			const t = new CostTracker(tempDir, logger);
			await t.loadMonthlyCache();

			// Only the two valid lines should be counted
			expect(t.getMonthlyTotalCost()).toBeCloseTo(0.0115, 5);
			expect(t.getMonthlyAppCost('chatbot')).toBeCloseTo(0.0105, 6);
			expect(t.getMonthlyAppCost('notes')).toBeCloseTo(0.001, 6);
		});
	});
});
