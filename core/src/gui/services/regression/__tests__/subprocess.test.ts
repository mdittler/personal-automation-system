/**
 * subprocess tests (Codex C3 + I3 + M4).
 *
 * C3: distinguish `complete | gate-failed | failed` based on whether
 * a `summary` event was received before exit.
 *
 * I3: skip unknown JSON types (Pino logs that leak to stdout) and
 * skip non-JSON lines; never let them surface as fake events.
 *
 * Arg allowlist: command-injection-style args raise before spawn.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
	type RegressionEvent,
	type SpawnProcLike,
	spawnRegression,
	validateSpawnArgs,
} from '../subprocess.js';

function fakeSpawnFactory(opts: {
	stdoutLines: string[];
	stderrLines?: string[];
	exitCode: number;
	delayMs?: number;
}): () => SpawnProcLike {
	return () => {
		const proc = new EventEmitter() as SpawnProcLike;
		const stdout = new Readable({ read() {} });
		const stderr = new Readable({ read() {} });
		proc.stdout = stdout;
		proc.stderr = stderr;
		proc.kill = () => true;
		proc.pid = 12345;
		setTimeout(() => {
			for (const line of opts.stdoutLines) stdout.push(`${line}\n`);
			for (const line of opts.stderrLines ?? []) stderr.push(`${line}\n`);
			stdout.push(null);
			stderr.push(null);
			setImmediate(() => proc.emit('exit', opts.exitCode, null));
		}, opts.delayMs ?? 1);
		return proc;
	};
}

async function runWith(opts: {
	stdoutLines: string[];
	stderrLines?: string[];
	exitCode: number;
}): Promise<RegressionEvent[]> {
	const evts: RegressionEvent[] = [];
	const handle = await spawnRegression(['--json'], {
		spawnFn: fakeSpawnFactory(opts),
		onEvent: (e) => evts.push(e),
	});
	await handle.whenComplete;
	return evts;
}

describe('spawnRegression — terminal-state classification (Codex C3)', () => {
	it('emits "complete" when summary received and exitCode=0', async () => {
		const evts = await runWith({
			stdoutLines: [JSON.stringify({ type: 'summary', summary: { totalCases: 1 } })],
			exitCode: 0,
		});
		expect(evts[evts.length - 1]?.type).toBe('complete');
	});

	it('emits "gate-failed" when summary received and exitCode=1 (REQ-REG-011)', async () => {
		const evts = await runWith({
			stdoutLines: [JSON.stringify({ type: 'summary', summary: { routingAccuracy: 0.5 } })],
			exitCode: 1,
		});
		expect(evts[evts.length - 1]?.type).toBe('gate-failed');
	});

	it('emits "failed" when NO summary received and exitCode=1 (crash, not gate fail)', async () => {
		const evts = await runWith({
			stdoutLines: [],
			stderrLines: ['fatal: something exploded'],
			exitCode: 1,
		});
		const terminal = evts[evts.length - 1] as { type: string; stderrTail?: string };
		expect(terminal.type).toBe('failed');
		expect(terminal.stderrTail).toContain('exploded');
	});

	it('emits "failed" when subprocess exits non-zero AND non-1 without summary', async () => {
		const evts = await runWith({ stdoutLines: [], exitCode: 137, stderrLines: ['killed'] });
		expect(evts[evts.length - 1]?.type).toBe('failed');
	});
});

describe('spawnRegression — event ordering', () => {
	it('emits case-result events in stream order, then summary, then complete', async () => {
		const evts = await runWith({
			stdoutLines: [
				JSON.stringify({ type: 'case-result', result: { caseId: 'a', verdict: 'pass' } }),
				JSON.stringify({ type: 'case-result', result: { caseId: 'b', verdict: 'fail' } }),
				JSON.stringify({ type: 'summary', summary: { totalCases: 2 } }),
			],
			exitCode: 0,
		});
		expect(evts.map((e) => e.type)).toEqual(['case-result', 'case-result', 'summary', 'complete']);
	});
});

describe('spawnRegression — Pino-on-stdout / non-JSON tolerance (I3)', () => {
	it('silently skips JSON lines with unknown "type" (e.g. Pino log)', async () => {
		const evts = await runWith({
			stdoutLines: [
				JSON.stringify({ level: 30, msg: 'pino warning leaked to stdout' }),
				JSON.stringify({ type: 'summary', summary: {} }),
			],
			exitCode: 0,
		});
		expect(evts.map((e) => e.type)).toEqual(['summary', 'complete']);
	});

	it('skips non-JSON lines (does not crash)', async () => {
		const evts = await runWith({
			stdoutLines: ['not json at all', JSON.stringify({ type: 'summary', summary: {} })],
			exitCode: 0,
		});
		expect(evts.map((e) => e.type)).toEqual(['summary', 'complete']);
	});

	it('stderr captured in failed event (4 KiB cap)', async () => {
		const big = 'x'.repeat(8000);
		const evts = await runWith({ stdoutLines: [], stderrLines: [big], exitCode: 1 });
		const terminal = evts[evts.length - 1] as { type: string; stderrTail?: string };
		expect(terminal.type).toBe('failed');
		expect(terminal.stderrTail?.length ?? 0).toBeLessThanOrEqual(4096);
		expect(terminal.stderrTail).toContain('x');
	});
});

describe('spawnRegression — cancel', () => {
	it('emits "cancelled" when handle.cancel() is called', async () => {
		const evts: RegressionEvent[] = [];
		const proc = new EventEmitter() as SpawnProcLike;
		const stdout = new Readable({ read() {} });
		const stderr = new Readable({ read() {} });
		proc.stdout = stdout;
		proc.stderr = stderr;
		let killed = false;
		proc.kill = () => {
			killed = true;
			// Simulate SIGTERM-driven exit: push EOF + emit exit.
			setImmediate(() => {
				stdout.push(null);
				stderr.push(null);
				proc.emit('exit', null, 'SIGTERM');
			});
			return true;
		};
		const handle = await spawnRegression(['--json'], {
			spawnFn: () => proc,
			onEvent: (e) => evts.push(e),
		});
		handle.cancel();
		await handle.whenComplete;
		expect(killed).toBe(true);
		expect(evts[evts.length - 1]?.type).toBe('cancelled');
	});
});

describe('validateSpawnArgs — allowlist (security)', () => {
	it('accepts --json', () => {
		expect(() => validateSpawnArgs(['--json'])).not.toThrow();
	});
	it('accepts --bucket=routing|receipt|chatbot|recall', () => {
		expect(() => validateSpawnArgs(['--json', '--bucket=routing'])).not.toThrow();
		expect(() => validateSpawnArgs(['--json', '--bucket=receipt'])).not.toThrow();
		expect(() => validateSpawnArgs(['--json', '--bucket=chatbot'])).not.toThrow();
		expect(() => validateSpawnArgs(['--json', '--bucket=recall'])).not.toThrow();
	});
	it('rejects --bucket=garbage', () => {
		expect(() => validateSpawnArgs(['--json', '--bucket=garbage'])).toThrow();
	});
	it('accepts --rerun=<safe-id>', () => {
		expect(() => validateSpawnArgs(['--json', '--rerun=food-save-recipe'])).not.toThrow();
	});
	it('rejects --rerun with shell metacharacters', () => {
		expect(() => validateSpawnArgs(['--json', '--rerun=; rm -rf /'])).toThrow();
		expect(() => validateSpawnArgs(['--json', '--rerun=foo`bar`'])).toThrow();
		expect(() => validateSpawnArgs(['--json', '--rerun=$EVIL'])).toThrow();
	});
	it('rejects --rerun pointing at traversal', () => {
		expect(() => validateSpawnArgs(['--json', '--rerun=../../etc/passwd'])).toThrow();
	});
	it('accepts the --rerun <id> two-token form (Codex I1)', () => {
		expect(() => validateSpawnArgs(['--json', '--rerun', 'food-save-recipe'])).not.toThrow();
	});
	it('rejects two-token --rerun with invalid id', () => {
		expect(() => validateSpawnArgs(['--json', '--rerun', 'BAD!!!'])).toThrow();
	});
	it('rejects unknown flags (e.g. --evil)', () => {
		expect(() => validateSpawnArgs(['--json', '--evil'])).toThrow();
	});
	it('accepts --list (used by case-discovery)', () => {
		expect(() => validateSpawnArgs(['--list', '--json'])).not.toThrow();
	});
	it('accepts --dry-run', () => {
		expect(() => validateSpawnArgs(['--dry-run', '--json'])).not.toThrow();
	});
});
