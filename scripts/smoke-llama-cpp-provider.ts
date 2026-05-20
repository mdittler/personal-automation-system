/**
 * End-to-end smoke test for LlamaCppProvider.
 *
 * Exercises the real provider class against a running OpenAI-compatible
 * server. Defaults to Ollama at http://localhost:11434/v1 because Ollama's
 * /v1/ endpoint is functionally identical to llama.cpp's `llama-server`
 * — same transport, same SDK code path. Set LLAMA_CPP_BASE_URL to point
 * at an actual llama-server if available.
 *
 * Verifies:
 *   1. listModels() returns at least one model
 *   2. completeWithUsage() returns text + usage + finishReason
 *   3. providerType + provider id are correctly tagged
 *   4. estimateCallCost() returns 0 for the actual usage tokens
 *   5. isLocalProvider(providerType) is true
 *
 * Run: cd .claude/worktrees/llm+llama-cpp-provider && pnpm tsx scripts/smoke-llama-cpp-provider.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { CostTracker } from '../core/src/services/llm/cost-tracker.js';
import { estimateCallCost, isLocalProvider } from '../core/src/services/llm/model-pricing.js';
import { LlamaCppProvider } from '../core/src/services/llm/providers/llama-cpp-provider.js';

const BASE_URL = process.env.LLAMA_CPP_BASE_URL ?? 'http://localhost:11434/v1';
const MODEL = process.env.LLAMA_CPP_MODEL ?? 'gemma4:e4b';

const logger = pino({ level: 'silent' });

function pass(msg: string) {
	console.log(`  ✓ ${msg}`);
}

function fail(msg: string, detail?: unknown): never {
	console.error(`  ✗ ${msg}`);
	if (detail !== undefined) console.error('    detail:', detail);
	process.exit(1);
}

async function main() {
	console.log('LlamaCppProvider smoke test');
	console.log(`  base URL: ${BASE_URL}`);
	console.log(`  model:    ${MODEL}`);
	console.log('');

	const tempDir = await mkdtemp(join(tmpdir(), 'pas-llama-cpp-smoke-'));
	try {
		const costTracker = new CostTracker(join(tempDir, 'data'), logger);

		const provider = new LlamaCppProvider({
			providerId: 'llama-cpp',
			defaultModel: MODEL,
			baseUrl: BASE_URL,
			logger,
			costTracker,
		});

		// --- 1. Provider shape ---
		console.log('1. Provider shape:');
		if (provider.providerType !== 'llama-cpp') fail('providerType', provider.providerType);
		pass(`providerType = ${provider.providerType}`);
		if (provider.providerId !== 'llama-cpp') fail('providerId', provider.providerId);
		pass(`providerId = ${provider.providerId}`);
		if (provider.supportsVision !== false)
			fail('supportsVision should be false', provider.supportsVision);
		pass('supportsVision = false (REQ-LLM-LLAMA-CPP-009)');
		if (!isLocalProvider(provider.providerType)) fail('isLocalProvider should be true');
		pass('isLocalProvider(providerType) = true (REQ-LLM-LLAMA-CPP-006)');
		console.log('');

		// --- 2. listModels ---
		console.log('2. listModels() against /v1/models:');
		const models = await provider.listModels();
		if (models.length === 0) fail('expected at least one model');
		pass(`got ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`);
		const allLocal = models.every((m) => m.providerType === 'llama-cpp');
		if (!allLocal) fail('every model should have providerType: llama-cpp');
		pass('every model tagged providerType = llama-cpp');
		const allFree = models.every((m) => m.pricing === null);
		if (!allFree) fail('every model should have pricing: null (REQ-LLM-LLAMA-CPP-006)', models);
		pass('every model has pricing: null even when id collides with priced remote model');
		console.log('');

		// --- 3. completeWithUsage (real chat round-trip) ---
		console.log('3. completeWithUsage() against /v1/chat/completions:');
		const t0 = Date.now();
		const result = await provider.completeWithUsage('Reply with exactly the single word: PONG', {
			maxTokens: 16,
			temperature: 0,
		});
		const elapsed = Date.now() - t0;
		pass(`call returned in ${elapsed}ms`);
		if (typeof result.text !== 'string' || result.text.length === 0) {
			fail('expected non-empty text', result);
		}
		pass(`text: "${result.text.replaceAll('\n', '\\n').slice(0, 80)}"`);
		if (result.provider !== 'llama-cpp') fail('provider field', result.provider);
		pass(`result.provider = ${result.provider}`);
		if (result.model !== MODEL) fail('model field', result.model);
		pass(`result.model = ${result.model}`);
		if (!result.finishReason) fail('finishReason missing');
		pass(`result.finishReason = ${result.finishReason}`);
		if (!result.usage) fail('usage missing');
		pass(
			`usage: { inputTokens: ${result.usage.inputTokens}, outputTokens: ${result.usage.outputTokens} }`,
		);
		console.log('');

		// --- 4. Cost path returns $0 ---
		console.log('4. Cost path:');
		const cost = estimateCallCost(
			MODEL,
			result.usage.inputTokens,
			result.usage.outputTokens,
			'llama-cpp',
		);
		if (cost !== 0) fail(`estimateCallCost returned ${cost}, expected 0`);
		pass(
			`estimateCallCost(model, ${result.usage.inputTokens}, ${result.usage.outputTokens}, 'llama-cpp') = 0`,
		);

		// Verify cost-tracker records $0 too
		await costTracker.record({
			model: MODEL,
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			provider: 'llama-cpp',
			providerType: 'llama-cpp',
			appId: 'smoke-test',
		});
		const monthly = await costTracker.getMonthlyAppCosts();
		const recorded = monthly.get('smoke-test') ?? 0;
		if (recorded !== 0) fail(`CostTracker recorded ${recorded}, expected 0`);
		pass('CostTracker.record() → $0 for smoke-test app');
		console.log('');

		// --- 5. JSON-mode plumbing ---
		console.log('5. responseFormat: "json" plumbing:');
		const jsonResult = await provider.completeWithUsage(
			'Return a JSON object with exactly one key "ok" set to true. No other text.',
			{ maxTokens: 64, temperature: 0, responseFormat: 'json' },
		);
		pass(`text: "${jsonResult.text.replaceAll('\n', '\\n').slice(0, 120)}"`);
		try {
			const parsed: unknown = JSON.parse(jsonResult.text);
			if (typeof parsed !== 'object' || parsed === null) {
				fail('JSON parse succeeded but result was not an object', parsed);
			}
			pass('parsed cleanly as JSON object (REQ-LLM-LLAMA-CPP-003)');
		} catch (err) {
			fail('JSON parse failed — response_format plumbing may be broken', err);
		}
		console.log('');

		console.log('SMOKE TEST PASSED');
		console.log('LlamaCppProvider works end-to-end against an OpenAI-compatible server.');
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error('\nSMOKE TEST FAILED');
	console.error(err);
	process.exit(1);
});
