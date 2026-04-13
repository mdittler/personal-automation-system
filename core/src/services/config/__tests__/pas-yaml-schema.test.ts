/**
 * Tests for D14 fix: Zod schema validation of pas.yaml.
 */

import { describe, expect, it } from 'vitest';
import { parsePasYamlConfig, PasYamlConfigSchema } from '../pas-yaml-schema.js';

describe('PasYamlConfigSchema', () => {
	it('accepts a valid minimal config (empty)', () => {
		const result = PasYamlConfigSchema.safeParse({});
		expect(result.success).toBe(true);
	});

	it('accepts a valid config with users', () => {
		const result = PasYamlConfigSchema.safeParse({
			users: [{ id: '123', name: 'Alice', is_admin: true }],
		});
		expect(result.success).toBe(true);
	});

	it('rejects a user missing required id', () => {
		const result = PasYamlConfigSchema.safeParse({
			users: [{ name: 'Alice' }],
		});
		expect(result.success).toBe(false);
		const issues = result.success ? [] : result.error.issues;
		expect(issues.some((i) => i.path.includes('id'))).toBe(true);
	});

	it('rejects a user with empty id', () => {
		const result = PasYamlConfigSchema.safeParse({
			users: [{ id: '', name: 'Alice' }],
		});
		expect(result.success).toBe(false);
	});

	it('rejects a user missing required name', () => {
		const result = PasYamlConfigSchema.safeParse({
			users: [{ id: '123' }],
		});
		expect(result.success).toBe(false);
	});

	it('accepts unknown top-level keys (passthrough)', () => {
		const result = PasYamlConfigSchema.safeParse({
			users: [],
			unknownFutureKey: 'value',
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect((result.data as any).unknownFutureKey).toBe('value');
		}
	});

	it('rejects null input (file-not-present handled upstream; null reaching schema is an error)', () => {
		const result = PasYamlConfigSchema.safeParse(null);
		expect(result.success).toBe(false);
	});

	it('rejects undefined input', () => {
		const result = PasYamlConfigSchema.safeParse(undefined);
		expect(result.success).toBe(false);
	});

	it('rejects non-object input (number)', () => {
		const result = PasYamlConfigSchema.safeParse(42);
		expect(result.success).toBe(false);
	});

	it('accepts valid LLM provider config', () => {
		const result = PasYamlConfigSchema.safeParse({
			llm: {
				providers: {
					anthropic: {
						type: 'anthropic',
						name: 'Anthropic',
						api_key_env: 'ANTHROPIC_API_KEY',
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it('rejects LLM provider missing api_key_env', () => {
		const result = PasYamlConfigSchema.safeParse({
			llm: {
				providers: {
					bad: {
						type: 'anthropic',
						name: 'Anthropic',
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it('rejects webhook with invalid URL', () => {
		const result = PasYamlConfigSchema.safeParse({
			webhooks: [{ id: 'hook1', url: 'not-a-url', events: ['report:completed'] }],
		});
		expect(result.success).toBe(false);
	});

	it('accepts webhook with valid URL', () => {
		const result = PasYamlConfigSchema.safeParse({
			webhooks: [{ id: 'hook1', url: 'https://example.com/webhook', events: ['report:completed'] }],
		});
		expect(result.success).toBe(true);
	});
});

describe('parsePasYamlConfig()', () => {
	it('returns parsed config for valid input', () => {
		const config = parsePasYamlConfig({ users: [{ id: '123', name: 'Alice' }] });
		expect(config.users).toHaveLength(1);
		expect(config.users![0].id).toBe('123');
	});

	it('throws a formatted Error on invalid input', () => {
		expect(() =>
			parsePasYamlConfig({ users: [{ name: 'Missing ID' }] }),
		).toThrow('Invalid pas.yaml configuration:');
	});

	it('error message includes path and reason', () => {
		let errorMessage = '';
		try {
			parsePasYamlConfig({ users: [{ id: '', name: 'Alice' }] });
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e);
		}
		expect(errorMessage).toContain('pas.yaml');
		expect(errorMessage).toContain('id');
	});

	it('passes through unknown keys', () => {
		const config = parsePasYamlConfig({ users: [], futureFeature: true });
		expect((config as any).futureFeature).toBe(true);
	});
});
