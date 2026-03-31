import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { ModelRef } from '../../../types/llm.js';
import { ensureDir } from '../../../utils/file.js';
import { ModelSelector } from '../model-selector.js';

const logger = pino({ level: 'silent' });
let tempDir: string;

const defaultStandard: ModelRef = { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
const defaultFast: ModelRef = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' };

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-model-sel-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('ModelSelector', () => {
	it('uses defaults when no saved selection exists', async () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		await selector.load();

		expect(selector.getStandardRef()).toEqual(defaultStandard);
		expect(selector.getFastRef()).toEqual(defaultFast);
	});

	it('backward compat: getStandardModel/getFastModel return model strings', async () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		expect(selector.getStandardModel()).toBe('claude-sonnet-4-20250514');
		expect(selector.getFastModel()).toBe('claude-haiku-4-5-20251001');
	});

	it('persists ModelRef selection to YAML file', async () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		await selector.setStandardRef({ provider: 'openai', model: 'gpt-4o' });
		await selector.setFastRef({ provider: 'google', model: 'gemini-2.0-flash' });

		expect(selector.getStandardRef()).toEqual({ provider: 'openai', model: 'gpt-4o' });
		expect(selector.getFastRef()).toEqual({ provider: 'google', model: 'gemini-2.0-flash' });

		const content = await readFile(join(tempDir, 'system', 'model-selection.yaml'), 'utf-8');
		expect(content).toContain('provider: openai');
		expect(content).toContain('model: gpt-4o');
	});

	it('loads saved ModelRef selection on startup', async () => {
		const selector1 = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});
		await selector1.setStandardRef({ provider: 'openai', model: 'gpt-4o' });
		await selector1.setFastRef({ provider: 'google', model: 'gemini-2.0-flash' });

		const selector2 = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});
		await selector2.load();

		expect(selector2.getStandardRef()).toEqual({ provider: 'openai', model: 'gpt-4o' });
		expect(selector2.getFastRef()).toEqual({ provider: 'google', model: 'gemini-2.0-flash' });
	});

	it('migrates old string format to ModelRef format', async () => {
		// Write old-format file (bare model strings, pre-Phase 11)
		await ensureDir(join(tempDir, 'system'));
		await writeFile(
			join(tempDir, 'system', 'model-selection.yaml'),
			stringify({ standard: 'claude-opus-4-6', fast: 'claude-sonnet-4-6' }),
			'utf-8',
		);

		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});
		await selector.load();

		// Model strings are preserved, provider inherited from defaults
		expect(selector.getStandardRef()).toEqual({
			provider: 'anthropic',
			model: 'claude-opus-4-6',
		});
		expect(selector.getFastRef()).toEqual({
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
		});

		// File re-saved in new format
		const content = await readFile(join(tempDir, 'system', 'model-selection.yaml'), 'utf-8');
		expect(content).toContain('provider: anthropic');
	});

	it('getTierRef returns correct ref for each tier', () => {
		const reasoning: ModelRef = { provider: 'anthropic', model: 'claude-opus-4-6' };
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			defaultReasoning: reasoning,
			logger,
		});

		expect(selector.getTierRef('fast')).toEqual(defaultFast);
		expect(selector.getTierRef('standard')).toEqual(defaultStandard);
		expect(selector.getTierRef('reasoning')).toEqual(reasoning);
	});

	it('setStandardModel keeps provider, changes model (backward compat)', async () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		await selector.setStandardModel('claude-opus-4-6');

		expect(selector.getStandardRef()).toEqual({
			provider: 'anthropic',
			model: 'claude-opus-4-6',
		});
		expect(selector.getStandardModel()).toBe('claude-opus-4-6');
	});

	it('setFastModel keeps provider, changes model (backward compat)', async () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		await selector.setFastModel('claude-sonnet-4-6');

		expect(selector.getFastRef()).toEqual({
			provider: 'anthropic',
			model: 'claude-sonnet-4-6',
		});
		expect(selector.getFastModel()).toBe('claude-sonnet-4-6');
	});

	it('persists and loads reasoning tier', async () => {
		const selector1 = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});
		await selector1.setReasoningRef({ provider: 'anthropic', model: 'claude-opus-4-6' });

		const selector2 = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});
		await selector2.load();

		expect(selector2.getReasoningRef()).toEqual({
			provider: 'anthropic',
			model: 'claude-opus-4-6',
		});
	});

	it('reasoning tier is undefined when not configured', () => {
		const selector = new ModelSelector({
			dataDir: tempDir,
			defaultStandard,
			defaultFast,
			logger,
		});

		expect(selector.getReasoningRef()).toBeUndefined();
		expect(selector.getTierRef('reasoning')).toBeUndefined();
	});
});
