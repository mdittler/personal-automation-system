/**
 * Bootstrap wiring tests for InteractionContextService.
 *
 * Two test strategies:
 *
 * 1. Structural source scan — reads bootstrap.ts and asserts that the
 *    conditional injection pattern exists. This is the same approach used
 *    by dispatch-context-wrap.test.ts for requestContext wraps: it catches
 *    the wiring disappearing in a future refactor without needing to stand
 *    up the full composition root.
 *
 * 2. Conditional injection unit test — directly exercises the
 *    declaredServices.has() guard logic using the real service class.
 *    This verifies both branches: app declaring 'interaction-context'
 *    receives a non-undefined service; app NOT declaring it receives
 *    undefined.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	InteractionContextServiceImpl,
	type InteractionContextService,
} from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readBootstrap(): Promise<string> {
	const path = join(__dirname, '..', '..', '..', 'bootstrap.ts');
	return readFile(path, 'utf8');
}

/** Strip line and block comments so documented-but-inactive code cannot pass scans. */
function stripComments(source: string): string {
	const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
	return noBlock.replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Helper that mirrors the serviceFactory conditional injection pattern
// ---------------------------------------------------------------------------

/**
 * Simulates the serviceFactory injection guard from bootstrap.ts.
 * Given a set of declared service names and a real service instance,
 * returns the service when 'interaction-context' is declared, undefined otherwise.
 */
function simulateInjection(
	declaredServices: Set<string>,
	service: InteractionContextService,
): InteractionContextService | undefined {
	return declaredServices.has('interaction-context') ? service : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InteractionContextService bootstrap wiring', () => {
	describe('structural source scan', () => {
		it('bootstrap.ts imports InteractionContextServiceImpl', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toContain('InteractionContextServiceImpl');
			expect(source).toContain("interaction-context/index.js'");
		});

		it('bootstrap.ts instantiates InteractionContextServiceImpl', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toMatch(/new\s+InteractionContextServiceImpl\s*\(\s*\)/);
		});

		it('bootstrap.ts conditionally injects interactionContext via declaredServices.has', async () => {
			const source = stripComments(await readBootstrap());
			// Verify the guard exists with the correct service key
			expect(source).toMatch(
				/declaredServices\.has\s*\(\s*['"]interaction-context['"]\s*\)/,
			);
			// Verify the field name in the returned services object
			expect(source).toMatch(/\binteractionContext\s*:/);
		});
	});

	describe('conditional injection logic', () => {
		it('app declaring interaction-context receives a non-undefined service', () => {
			const service = new InteractionContextServiceImpl();
			const declared = new Set(['telegram', 'data-store', 'interaction-context']);

			const result = simulateInjection(declared, service);

			expect(result).not.toBeUndefined();
			expect(result).toBe(service);
		});

		it('app NOT declaring interaction-context receives undefined', () => {
			const service = new InteractionContextServiceImpl();
			const declared = new Set(['telegram', 'data-store', 'llm']);

			const result = simulateInjection(declared, service);

			expect(result).toBeUndefined();
		});

		it('injected service is functional — record() and getRecent() work', () => {
			const service = new InteractionContextServiceImpl();
			const declared = new Set(['interaction-context']);

			const injected = simulateInjection(declared, service);
			expect(injected).not.toBeUndefined();

			// Verify the injected service is operational
			injected!.record('user1', { appId: 'food', action: 'view-recipe' });
			const entries = injected!.getRecent('user1');
			expect(entries).toHaveLength(1);
			expect(entries[0]!.action).toBe('view-recipe');
		});

		it('same singleton is injected regardless of which app requests it', () => {
			// In bootstrap, interactionContextService is created once before serviceFactory.
			// All apps that declare 'interaction-context' receive the same instance,
			// enabling cross-app interaction context sharing within the same process.
			const sharedService = new InteractionContextServiceImpl();

			const foodDeclared = new Set(['telegram', 'data-store', 'interaction-context']);
			const chatbotDeclared = new Set(['telegram', 'llm', 'data-query', 'interaction-context']);

			const foodResult = simulateInjection(foodDeclared, sharedService);
			const chatbotResult = simulateInjection(chatbotDeclared, sharedService);

			// Both point to the same instance — state written by food is visible to chatbot
			expect(foodResult).toBe(chatbotResult);

			foodResult!.record('user1', { appId: 'food', action: 'capture-receipt' });
			const chatbotEntries = chatbotResult!.getRecent('user1');
			expect(chatbotEntries).toHaveLength(1);
			expect(chatbotEntries[0]!.action).toBe('capture-receipt');
		});
	});

	describe('manifest declarations', () => {
		it('chatbot manifest declares interaction-context', async () => {
			// __tests__ -> interaction-context -> services -> src -> core -> d2c (root)
			const manifestPath = join(
				__dirname,
				'..',
				'..',
				'..',
				'..',
				'..',
				'apps',
				'chatbot',
				'manifest.yaml',
			);
			const content = await readFile(manifestPath, 'utf8');
			expect(content).toContain('interaction-context');
		});

		it('food manifest declares interaction-context', async () => {
			// __tests__ -> interaction-context -> services -> src -> core -> d2c (root)
			const manifestPath = join(
				__dirname,
				'..',
				'..',
				'..',
				'..',
				'..',
				'apps',
				'food',
				'manifest.yaml',
			);
			const content = await readFile(manifestPath, 'utf8');
			expect(content).toContain('interaction-context');
		});
	});
});
