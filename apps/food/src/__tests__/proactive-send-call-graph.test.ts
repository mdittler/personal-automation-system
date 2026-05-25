/**
 * REQ-FOOD-PROACTIVE-BRIDGE-008..011 — Strategy B transitive call-graph
 * guard. Build a small temp project per test, run the scanner, assert
 * hits.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findReachableSends } from '../testing/proactive-send-call-graph.js';

let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'test-call-graph-'));
});
afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

function writeFile(rel: string, contents: string): void {
	const abs = join(work, rel);
	mkdirSync(join(abs, '..'), { recursive: true });
	writeFileSync(abs, contents);
}

const TSCONFIG = JSON.stringify({
	compilerOptions: {
		target: 'es2022',
		module: 'node16',
		moduleResolution: 'node16',
		strict: true,
		allowImportingTsExtensions: false,
		noEmit: true,
	},
	include: ['**/*.ts'],
});

describe('Strategy B call-graph guard — direct entrypoint sends', () => {
	it('flags a raw telegram.send inside an entrypoint (no helper involved)', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(services: Services): Promise<void> {
				await services.telegram.send('u1', 'hello');
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ fn: 'handlePerishableCheckJob' });
	});
});

describe('Strategy B — transitive same-file helper', () => {
	it('flags a telegram.send inside a helper that the entrypoint calls', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			async function unbridgedHelper(services: Services): Promise<void> {
				await services.telegram.send('u1', 'leaked');
			}
			export async function handlePerishableCheckJob(services: Services): Promise<void> {
				await unbridgedHelper(services);
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits.some((h) => h.fn === 'unbridgedHelper')).toBe(true);
	});
});

describe('Strategy B — cross-file helper resolution', () => {
	it('flags a telegram.send in a helper defined in another file', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			import { unbridgedHelper } from './helpers.js';
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(services: Services): Promise<void> {
				await unbridgedHelper(services);
			}
		`,
		);
		writeFile(
			'helpers.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function unbridgedHelper(services: Services): Promise<void> {
				await services.telegram.send('u1', 'cross-file leak');
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits.some((h) => h.fn === 'unbridgedHelper')).toBe(true);
	});
});

describe('Strategy B — cycle safety', () => {
	it('does not infinite-loop on mutually-recursive helpers', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			async function a(s: Services): Promise<void> { await b(s); }
			async function b(s: Services): Promise<void> { await a(s); await s.telegram.send('u1', 'x'); }
			export async function handlePerishableCheckJob(s: Services): Promise<void> { await a(s); }
		`,
		);
		// Use a short Vitest timeout to assert termination.
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits.some((h) => h.fn === 'b')).toBe(true);
	}, /* 3-second cap on this test */ 3_000);
});

describe('Strategy B — non-reachable code is not flagged', () => {
	it('does not flag a telegram.send that no entrypoint can reach', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(): Promise<void> { /* no sends */ }
			export async function reactiveHandler(services: Services): Promise<void> {
				await services.telegram.send('u1', 'reactive — allowed');
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits).toEqual([]);
	});
});

describe('Strategy B — exclusions', () => {
	it('excludes __tests__/, testing/, and utils/proactive-message.ts even when reachable', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			import { sendProactiveMessage } from './utils/proactive-message.js';
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(services: Services): Promise<void> {
				await sendProactiveMessage(services, { userId: 'u1', body: 'ok', kind: 'perishable-check' });
			}
		`,
		);
		writeFile(
			'utils/proactive-message.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function sendProactiveMessage(s: Services, opts: { userId: string; body: string; kind: string }): Promise<void> {
				await s.telegram.send(opts.userId, opts.body); // sanctioned bridge
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits).toEqual([]);
	});
});

describe('Strategy B — alias / aliased call sites', () => {
	it('flags telegram.send through a destructured alias', () => {
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'jobs.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(services: Services): Promise<void> {
				const { telegram } = services;
				await telegram.send('u1', 'aliased');
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
		});
		expect(hits.some((h) => h.fn === 'handlePerishableCheckJob')).toBe(true);
	});
});

describe('Strategy B — all telegram.send* variants (Codex #14)', () => {
	for (const method of ['send', 'sendWithButtons', 'sendPhoto', 'sendOptions']) {
		it(`flags telegram.${method} reachable via a transitive helper`, () => {
			writeFile('tsconfig.json', TSCONFIG);
			writeFile(
				'jobs.ts',
				`
				interface Services {
					telegram: {
						send(userId: string, text: string): Promise<void>;
						sendWithButtons(userId: string, text: string, b: unknown[][]): Promise<{chatId:number;messageId:number}>;
						sendPhoto(userId: string, photo: unknown, caption?: string): Promise<void>;
						sendOptions(userId: string, prompt: string, options: string[]): Promise<string>;
					}
				}
				async function helper(services: Services): Promise<void> {
					await services.telegram.${method}('u1', ${
						method === 'sendOptions'
							? "'pick', ['a','b']"
							: method === 'sendWithButtons'
								? "'Confirm?', [[{text:'Yes',callbackData:'y'}]]"
								: method === 'sendPhoto'
									? "Buffer.alloc(0), 'cap'"
									: "'msg'"
					});
				}
				export async function handlePerishableCheckJob(s: Services): Promise<void> {
					await helper(s);
				}
			`,
			);
			const hits = findReachableSends({
				projectRoot: work,
				entrypoints: ['handlePerishableCheckJob'],
			});
			expect(
				hits.some((h) => h.fn === 'helper'),
				`expected ${method} to be flagged`,
			).toBe(true);
		});
	}
});

describe('Strategy B — production-root exclusion shape (Codex #12)', () => {
	it('the real sanctioned bridge path "utils/proactive-message.ts" is excluded under projectRoot=apps/food/src', () => {
		// Mirror the production layout: projectRoot is apps/food/src; the
		// sanctioned file is utils/proactive-message.ts (relative to root).
		// This pins that exclusion strings are matched relative to the passed
		// root, not the cwd.
		writeFile('tsconfig.json', TSCONFIG);
		writeFile(
			'utils/proactive-message.ts',
			`
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function sendProactiveMessage(s: Services, opts: { userId: string; body: string }): Promise<void> {
				await s.telegram.send(opts.userId, opts.body);
			}
		`,
		);
		writeFile(
			'jobs.ts',
			`
			import { sendProactiveMessage } from './utils/proactive-message.js';
			interface Services { telegram: { send(userId: string, text: string): Promise<void> } }
			export async function handlePerishableCheckJob(s: Services): Promise<void> {
				await sendProactiveMessage(s, { userId: 'u1', body: 'ok' });
			}
		`,
		);
		const hits = findReachableSends({
			projectRoot: work,
			entrypoints: ['handlePerishableCheckJob'],
			excludeFiles: ['utils/proactive-message.ts'],
		});
		expect(hits).toEqual([]);
	});
});
