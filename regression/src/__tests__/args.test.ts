import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../runner/args.js';

describe('parseCliArgs', () => {
	it('defaults to all buckets, no rerun, no dry-run, no JSON, no help', () => {
		expect(parseCliArgs([])).toEqual({
			bucketFilter: undefined,
			rerunIds: undefined,
			dryRun: false,
			json: false,
			help: false,
		});
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
		});
	});

	it('rejects unknown flags', () => {
		expect(() => parseCliArgs(['--garbage'])).toThrow(/unknown flag.*--garbage/i);
	});

	it('rejects positional args (no positional support yet)', () => {
		expect(() => parseCliArgs(['somepositional'])).toThrow(/unknown flag/i);
	});
});
