/**
 * Static guard: any `telegram.send` / `telegram.sendWithButtons` call inside
 * a Food proactive entrypoint MUST be routed through `sendProactiveMessage`
 * (apps/food/src/utils/proactive-message.ts), so the chatbot transcript
 * stays in sync via the AppOutboundBridge.
 *
 * Two assertions:
 *
 *  1. Self-test of the scanner — feed it an in-memory fixture whose function
 *     name is one of `PROACTIVE_ENTRYPOINTS` containing a raw
 *     `services.telegram.send(...)` call, confirm it flags.
 *
 *  2. Real assertion — run the scanner against `apps/food/src/` (excluding
 *     `__tests__/`, `testing/`, and `utils/proactive-message.ts`) and assert
 *     the returned array is empty.
 *
 * Why entrypoint-scoped, not file-scoped: `apps/food/src/index.ts` mixes
 * scheduled jobs (proactive) and reactive command/callback handlers in one
 * file — a file-scoped scanner would false-positive on every reactive send.
 *
 * Failure message points developers at `sendProactiveMessage` and
 * `docs/CREATING_AN_APP.md` (the "Proactive Messages and the Chatbot Bridge"
 * section).
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	PROACTIVE_ENTRYPOINTS,
	scanFoodProactiveSends,
	scanFoodProactiveSendsFromSources,
} from '../testing/proactive-send-scan.js';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function formatMessage(flagged: ReadonlyArray<{ file: string; line: number; fn: string }>): string {
	if (flagged.length === 0) return '';
	const lines = [
		'Found unbridged proactive Telegram sends inside Food proactive entrypoints.',
		'Every proactive (app-initiated, non-reply) send from a Food entrypoint must',
		'go through `sendProactiveMessage` (apps/food/src/utils/proactive-message.ts)',
		'so the chatbot transcript stays in sync via the AppOutboundBridge.',
		'',
		'See docs/CREATING_AN_APP.md — section "Proactive Messages and the Chatbot Bridge".',
		'',
		'Offending sites:',
	];
	for (const hit of flagged) {
		lines.push(`  ${hit.file}:${hit.line}  inside ${hit.fn}()`);
	}
	return lines.join('\n');
}

describe('Food proactive-send guard', () => {
	it('self-test: scanner flags a raw telegram.send inside a proactive entrypoint name', () => {
		// Pick any proactive entrypoint name so the self-test exercises the
		// real PROACTIVE_ENTRYPOINTS membership check.
		const fnName = [...PROACTIVE_ENTRYPOINTS][0];
		expect(fnName).toBeDefined();

		const fixture = `
			import type { CoreServices } from '@pas/core/types';
			export async function ${fnName}(services: CoreServices): Promise<void> {
				await services.telegram.send('user-1', 'hello, world');
			}
		`;

		const flagged = scanFoodProactiveSendsFromSources([{ file: 'fixture.ts', source: fixture }]);

		expect(flagged.length).toBeGreaterThan(0);
		expect(flagged.some((h) => h.fn === fnName)).toBe(true);
	});

	it('real: no unbridged proactive sends in apps/food/src', () => {
		const flagged = scanFoodProactiveSends(SRC_DIR);
		expect(flagged, formatMessage(flagged)).toEqual([]);
	});
});
