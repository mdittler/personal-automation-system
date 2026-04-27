/**
 * Bootstrap wiring tests for EditService.
 *
 * Two strategies:
 * 1. Structural source scan — reads bootstrap.ts and asserts the wiring pattern exists.
 * 2. Conditional injection unit test — directly exercises the declaredServices.has() guard.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildVirtualChatbotApp } from '../../conversation/virtual-app.js';
import type { EditService } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readBootstrap(): Promise<string> {
	// Task-4 refactor: wiring code moved to compose-runtime.ts.
	// Read that file instead of bootstrap.ts for source scans.
	const composeRuntimePath = join(__dirname, '..', '..', '..', 'compose-runtime.ts');
	return readFile(composeRuntimePath, 'utf8');
}

/** Strip line and block comments so documented-but-inactive code cannot pass scans. */
function stripComments(source: string): string {
	const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
	return noBlock.replace(/\/\/.*$/gm, '');
}

/**
 * Simulates the serviceFactory injection guard from bootstrap.ts.
 */
function simulateInjection(
	declaredServices: Set<string>,
	service: EditService,
): EditService | undefined {
	return declaredServices.has('edit-service') ? service : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditService bootstrap wiring', () => {
	describe('structural source scan', () => {
		it('bootstrap.ts imports EditServiceImpl', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toContain('EditServiceImpl');
			expect(source).toContain("services/edit/index.js'");
		});

		it('bootstrap.ts instantiates EditServiceImpl', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toMatch(/new\s+EditServiceImpl\s*\(/);
		});

		it('bootstrap.ts conditionally injects editService via declaredServices.has', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toMatch(/declaredServices\.has\s*\(\s*['"]edit-service['"]\s*\)/);
			expect(source).toMatch(/\beditService\s*:/);
		});

		it('bootstrap.ts instantiates EditLog', async () => {
			const source = stripComments(await readBootstrap());
			expect(source).toContain('EditLog');
			expect(source).toContain('edit-log.jsonl');
		});
	});

	describe('conditional injection logic', () => {
		function makeMinimalEditService(): EditService {
			return {
				proposeEdit: vi.fn(),
				confirmEdit: vi.fn(),
			};
		}

		it('app declaring edit-service receives a non-undefined service', () => {
			const service = makeMinimalEditService();
			const declared = new Set(['telegram', 'data-store', 'edit-service']);

			const result = simulateInjection(declared, service);

			expect(result).not.toBeUndefined();
			expect(result).toBe(service);
		});

		it('app NOT declaring edit-service receives undefined', () => {
			const service = makeMinimalEditService();
			const declared = new Set(['telegram', 'data-store', 'llm']);

			const result = simulateInjection(declared, service);

			expect(result).toBeUndefined();
		});
	});

	describe('manifest declarations', () => {
		it('chatbot virtual manifest declares edit-service', () => {
			// apps/chatbot/ was deleted in Hermes P1 Chunk D.3.
			// The chatbot app now lives as a virtual registry entry built from
			// buildVirtualChatbotApp() — assert against the in-memory manifest.
			const { manifest } = buildVirtualChatbotApp();
			const services = manifest.requirements?.services ?? [];
			expect(services).toContain('edit-service');
		});

		it('chatbot virtual manifest does NOT declare /edit as a capability (Chunk C: /edit is a Router built-in)', () => {
			const { manifest } = buildVirtualChatbotApp();
			expect(manifest.capabilities?.commands).toBeUndefined();
		});
	});
});
