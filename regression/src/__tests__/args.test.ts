import { describe, expect, it } from 'vitest';
import { RUN_ID_RE, buildTierOverrideFromCli, parseCliArgs } from '../runner/args.js';

describe('parseCliArgs', () => {
	it('defaults to all buckets, no rerun, no dry-run, no JSON, no help, no list, no no-cache, no run-id', () => {
		expect(parseCliArgs([])).toEqual({
			bucketFilter: undefined,
			rerunIds: undefined,
			dryRun: false,
			json: false,
			help: false,
			listOnly: false,
			noCache: false,
			runId: undefined,
			modelMatrix: undefined,
			judgeModel: undefined,
		});
	});

	describe('--run-id (REQ-REG-GUI-V2-003)', () => {
		const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

		it('parses --run-id=<uuid> (equals form)', () => {
			expect(parseCliArgs([`--run-id=${VALID_UUID}`]).runId).toBe(VALID_UUID);
		});

		it('parses --run-id <uuid> (space form)', () => {
			expect(parseCliArgs(['--run-id', VALID_UUID]).runId).toBe(VALID_UUID);
		});

		it('rejects a non-UUID --run-id (equals form)', () => {
			expect(() => parseCliArgs(['--run-id=hello'])).toThrow(/--run-id must be a UUID/);
		});

		it('rejects a non-UUID --run-id (space form)', () => {
			expect(() => parseCliArgs(['--run-id', 'hello'])).toThrow(/--run-id requires a UUID/);
		});

		it('rejects an empty --run-id', () => {
			expect(() => parseCliArgs(['--run-id='])).toThrow(/--run-id must be a UUID/);
		});

		it('RUN_ID_RE accepts UUID v1-v5 shapes (case-insensitive)', () => {
			expect(RUN_ID_RE.test(VALID_UUID)).toBe(true);
			expect(RUN_ID_RE.test(VALID_UUID.toUpperCase())).toBe(true);
			expect(RUN_ID_RE.test('00000000-0000-1000-8000-000000000000')).toBe(true); // v1
			expect(RUN_ID_RE.test('00000000-0000-5000-b000-000000000000')).toBe(true); // v5
		});

		it('RUN_ID_RE rejects malformed strings', () => {
			expect(RUN_ID_RE.test('')).toBe(false);
			expect(RUN_ID_RE.test('not-a-uuid')).toBe(false);
			expect(RUN_ID_RE.test('550e8400-e29b-41d4-a716')).toBe(false); // too short
			expect(RUN_ID_RE.test('550e8400-e29b-01d4-a716-446655440000')).toBe(false); // version 0
			expect(RUN_ID_RE.test('550e8400-e29b-71d4-a716-446655440000')).toBe(false); // version 7
		});
	});

	it('parses --list', () => {
		expect(parseCliArgs(['--list']).listOnly).toBe(true);
	});

	it('parses --rerun=<id> (equals form)', () => {
		const o = parseCliArgs(['--rerun=food-a']);
		expect(o.rerunIds).toEqual(new Set(['food-a']));
	});

	it('accepts both --rerun forms together', () => {
		const o = parseCliArgs(['--rerun=food-a', '--rerun', 'food-b']);
		expect(o.rerunIds).toEqual(new Set(['food-a', 'food-b']));
	});

	it('rejects --rerun=<id> with invalid id (regex)', () => {
		expect(() => parseCliArgs(['--rerun=BAD!!!'])).toThrow(/--rerun.*id/i);
	});

	it('rejects --rerun=<empty>', () => {
		expect(() => parseCliArgs(['--rerun='])).toThrow(/--rerun/i);
	});

	it('rejects --rerun <id> (space-form) with invalid id', () => {
		expect(() => parseCliArgs(['--rerun', 'BAD!!!'])).toThrow(/--rerun.*id/i);
	});

	it('parses --bucket=routing (=-form)', () => {
		expect(parseCliArgs(['--bucket=routing']).bucketFilter).toBe('routing');
	});

	it('parses --bucket routing (space-form)', () => {
		expect(parseCliArgs(['--bucket', 'routing']).bucketFilter).toBe('routing');
	});

	it.each(['receipt', 'chatbot', 'recall'])('accepts bucket=%s', (b) => {
		expect(parseCliArgs([`--bucket=${b}`]).bucketFilter).toBe(b);
	});

	it('rejects unknown bucket (=-form)', () => {
		expect(() => parseCliArgs(['--bucket=garbage'])).toThrow(/unknown bucket/i);
	});

	it('rejects unknown bucket (space-form)', () => {
		expect(() => parseCliArgs(['--bucket', 'garbage'])).toThrow(/--bucket requires/i);
	});

	it('rejects --bucket with missing argument', () => {
		expect(() => parseCliArgs(['--bucket'])).toThrow(/--bucket requires/i);
	});

	it('parses --rerun with multiple ids', () => {
		const o = parseCliArgs(['--rerun', 'food-a', '--rerun', 'food-b']);
		expect(o.rerunIds).toEqual(new Set(['food-a', 'food-b']));
	});

	it('rejects --rerun without an id', () => {
		expect(() => parseCliArgs(['--rerun'])).toThrow(/--rerun requires/i);
	});

	it('rejects --rerun where the next arg is a flag', () => {
		expect(() => parseCliArgs(['--rerun', '--dry-run'])).toThrow(/--rerun requires/i);
	});

	it('parses --dry-run', () => {
		expect(parseCliArgs(['--dry-run']).dryRun).toBe(true);
	});

	it('parses --json', () => {
		expect(parseCliArgs(['--json']).json).toBe(true);
	});

	it('parses --help and -h', () => {
		expect(parseCliArgs(['--help']).help).toBe(true);
		expect(parseCliArgs(['-h']).help).toBe(true);
	});

	it('combines flags correctly', () => {
		const o = parseCliArgs(['--bucket=routing', '--dry-run', '--json', '--rerun', 'a']);
		expect(o).toEqual({
			bucketFilter: 'routing',
			rerunIds: new Set(['a']),
			dryRun: true,
			json: true,
			help: false,
			listOnly: false,
			noCache: false,
		});
	});

	it('rejects unknown flags', () => {
		expect(() => parseCliArgs(['--garbage'])).toThrow(/unknown flag.*--garbage/i);
	});

	it('rejects positional args (no positional support yet)', () => {
		expect(() => parseCliArgs(['somepositional'])).toThrow(/unknown flag/i);
	});

	it('skips a leading -- separator (pnpm forward-arg compatibility)', () => {
		expect(parseCliArgs(['--', '--help']).help).toBe(true);
		expect(parseCliArgs(['--', '--bucket=routing']).bucketFilter).toBe('routing');
	});
});

describe('--model-matrix + --judge-model parsing', () => {
	it('parses positional comma form: --model-matrix=ollama/gemma4:e4b,anthropic/claude-sonnet-4-7', () => {
		const o = parseCliArgs(['--model-matrix=ollama/gemma4:e4b,anthropic/claude-sonnet-4-7']);
		expect(o.modelMatrix).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:e4b' },
			standard: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
		});
	});

	it('parses tier=provider/model form: --model-matrix=standard=ollama/gemma4:26b', () => {
		const o = parseCliArgs(['--model-matrix=standard=ollama/gemma4:26b']);
		expect(o.modelMatrix).toEqual({
			standard: { provider: 'ollama', model: 'gemma4:26b' },
		});
	});

	it('rejects an empty model-matrix value', () => {
		expect(() => parseCliArgs(['--model-matrix='])).toThrow(/empty|required/i);
	});

	it('rejects an entry without a slash separator', () => {
		expect(() => parseCliArgs(['--model-matrix=ollama-gemma4:e4b'])).toThrow(/provider\/model/i);
	});

	it('parses --judge-model=ollama/gemma4:26b', () => {
		const o = parseCliArgs(['--judge-model=ollama/gemma4:26b']);
		expect(o.judgeModel).toEqual({ provider: 'ollama', model: 'gemma4:26b' });
	});

	it('rejects --judge-model without a value', () => {
		expect(() => parseCliArgs(['--judge-model'])).toThrow(/judge-model requires/i);
	});
});

describe('--no-cache flag', () => {
	it('default is noCache: false', () => {
		expect(parseCliArgs([]).noCache).toBe(false);
	});

	it('parses --no-cache to noCache: true', () => {
		expect(parseCliArgs(['--no-cache']).noCache).toBe(true);
	});

	it('combines with other flags', () => {
		const o = parseCliArgs(['--no-cache', '--bucket=routing', '--json']);
		expect(o.noCache).toBe(true);
		expect(o.bucketFilter).toBe('routing');
		expect(o.json).toBe(true);
	});
});

describe('buildTierOverrideFromCli', () => {
	// Codex correction #3 + plan Batch 0 test: --judge-model must win over
	// --model-matrix=standard= for the standard slot.
	it('returns undefined when neither modelMatrix nor judgeModel is set', () => {
		expect(buildTierOverrideFromCli({ dryRun: false, json: false, help: false, listOnly: false, noCache: false })).toBeUndefined();
	});

	it('builds override from --model-matrix only', () => {
		const opts = parseCliArgs(['--model-matrix=ollama/gemma4:e4b']);
		expect(buildTierOverrideFromCli(opts)).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:e4b' },
		});
	});

	it('builds override from --judge-model only (lands in standard slot)', () => {
		const opts = parseCliArgs(['--judge-model=ollama/gemma4:26b']);
		expect(buildTierOverrideFromCli(opts)).toEqual({
			standard: { provider: 'ollama', model: 'gemma4:26b' },
		});
	});

	it('--judge-model WINS over --model-matrix=standard= for the standard slot', () => {
		const opts = parseCliArgs([
			'--judge-model=ollama/gemma4:26b',
			'--model-matrix=standard=anthropic/claude-sonnet-4-6',
		]);
		expect(buildTierOverrideFromCli(opts)).toEqual({
			standard: { provider: 'ollama', model: 'gemma4:26b' },
		});
	});

	it('combines --model-matrix fast + --judge-model standard', () => {
		const opts = parseCliArgs([
			'--model-matrix=ollama/gemma4:e4b',
			'--judge-model=ollama/gemma4:26b',
		]);
		expect(buildTierOverrideFromCli(opts)).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:e4b' },
			standard: { provider: 'ollama', model: 'gemma4:26b' },
		});
	});

	it('preserves model-matrix reasoning even when judge-model takes standard', () => {
		const opts = parseCliArgs([
			'--model-matrix=fast=ollama/gemma4:e4b,reasoning=anthropic/claude-opus-4-7',
			'--judge-model=ollama/gemma4:26b',
		]);
		expect(buildTierOverrideFromCli(opts)).toEqual({
			fast: { provider: 'ollama', model: 'gemma4:e4b' },
			standard: { provider: 'ollama', model: 'gemma4:26b' },
			reasoning: { provider: 'anthropic', model: 'claude-opus-4-7' },
		});
	});
});
