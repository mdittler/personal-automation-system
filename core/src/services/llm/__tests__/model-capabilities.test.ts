import { describe, expect, it } from 'vitest';
import {
	MODEL_CAPABILITIES,
	getModelCapabilities,
	openAIOutputLimitField,
	supportsTemperature,
} from '../model-capabilities.js';

describe('model-capabilities', () => {
	describe('getModelCapabilities', () => {
		it('returns the record for a known model', () => {
			expect(getModelCapabilities('claude-opus-5')).toEqual({ supportsTemperature: false });
		});

		it('returns null for an unknown model', () => {
			expect(getModelCapabilities('totally-unknown-model')).toBeNull();
		});
	});

	describe('supportsTemperature', () => {
		it('returns false for a probed model that rejects temperature', () => {
			// The observed regression: claude-opus-5 answers `temperature` with a 400.
			expect(supportsTemperature('claude-opus-5')).toBe(false);
		});

		it('returns true for a probed model that accepts temperature', () => {
			expect(supportsTemperature('claude-sonnet-4-6')).toBe(true);
		});

		it('defaults to true for an unknown model so behaviour is unchanged', () => {
			expect(supportsTemperature('totally-unknown-model')).toBe(true);
		});

		it('defaults to true for an empty model id', () => {
			expect(supportsTemperature('')).toBe(true);
		});

		it('does not resolve inherited Object.prototype keys as capability entries', () => {
			expect(supportsTemperature('constructor')).toBe(true);
			expect(supportsTemperature('toString')).toBe(true);
			expect(getModelCapabilities('constructor')).toBeNull();
		});
	});

	describe('MODEL_CAPABILITIES table', () => {
		it('lists every entry with an explicit boolean flag', () => {
			for (const [modelId, caps] of Object.entries(MODEL_CAPABILITIES)) {
				expect(typeof caps.supportsTemperature, `${modelId} flag`).toBe('boolean');
			}
		});

		it('marks the Claude 5 family as not supporting temperature', () => {
			for (const modelId of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
				expect(supportsTemperature(modelId), modelId).toBe(false);
			}
		});
	});
});

describe('openAIOutputLimitField (REQ-LLM-047, R1-4)', () => {
	it.each([
		['o3', 'max_completion_tokens'],
		['o3-mini', 'max_completion_tokens'],
		['o4-mini', 'max_completion_tokens'],
		['o1', 'max_completion_tokens'],
		['gpt-5', 'max_completion_tokens'],
		['gpt-5-mini', 'max_completion_tokens'],
		['gpt-4o', 'max_tokens'],
		['gpt-4.1-mini', 'max_tokens'],
		['local-model', 'max_tokens'],
		['qwen3.8:27b-mlx', 'max_tokens'],
		['openai/o3-mini', 'max_tokens'], // namespaced ids are served by routers that expect max_tokens
	] as const)('%s → %s', (model, field) => {
		expect(openAIOutputLimitField(model)).toBe(field);
	});
});
