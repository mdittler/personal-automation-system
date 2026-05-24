/**
 * Static guard: any `telegram.send*` call reachable from a Food proactive
 * entrypoint MUST be routed through `sendProactiveMessage`
 * (apps/food/src/utils/proactive-message.ts), so the chatbot transcript
 * stays in sync via the AppOutboundBridge.
 *
 * Strategy B (2026-05-24): transitive call-graph reachability. The
 * scanner walks the call graph BFS from each `PROACTIVE_ENTRYPOINTS`
 * member, using the TypeScript type checker for cross-file symbol
 * resolution. Sanctioned files (`__tests__/`, `testing/`,
 * `utils/proactive-message.ts`) are excluded.
 *
 * Two assertions:
 *
 *  1. Self-test of the in-memory scanner — feed it an in-memory fixture
 *     whose function name is one of `PROACTIVE_ENTRYPOINTS` containing a
 *     raw `services.telegram.send(...)` call, confirm it flags.
 *
 *  2. Real assertion — run the Strategy B sweep against `apps/food/src/`
 *     and assert the returned array is empty.
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

// SRC_DIR points at `apps/food/src` — the production sweep root.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function formatMessage(flagged: ReadonlyArray<{ file: string; line: number; fn: string }>): string {
	if (flagged.length === 0) return '';
	return [
		'Found unbridged proactive Telegram sends reachable from a Food proactive entrypoint.',
		'Every proactive (app-initiated, non-reply) send must go through',
		'`sendProactiveMessage` (apps/food/src/utils/proactive-message.ts) so the chatbot',
		'transcript stays in sync via the AppOutboundBridge.',
		'',
		'See docs/CREATING_AN_APP.md — section "Proactive Messages and the Chatbot Bridge".',
		'',
		'Offending sites (transitively reachable):',
		...flagged.map((h) => `  ${h.file}:${h.line}  inside ${h.fn}()`),
	].join('\n');
}

describe('Food proactive-send guard (Strategy B)', () => {
	it('self-test: in-memory scanner flags a raw telegram.send inside a named entrypoint', () => {
		const entry = [...PROACTIVE_ENTRYPOINTS][0];
		const fixture = `
			import type { CoreServices } from '@pas/core/types';
			export async function ${entry}(services: CoreServices): Promise<void> {
				await services.telegram.send('user-1', 'hello, world');
			}
		`;
		const flagged = scanFoodProactiveSendsFromSources([{ file: 'fixture.ts', source: fixture }]);
		expect(flagged.length).toBeGreaterThan(0);
		expect(flagged.some((h) => h.fn === entry)).toBe(true);
	});

	it('real: no unbridged proactive sends reachable in apps/food/src (Strategy B sweep)', () => {
		const flagged = scanFoodProactiveSends(SRC_DIR);
		expect(flagged, formatMessage(flagged)).toEqual([]);
	});
});
