/**
 * DataQueryService — context hints tests (Task 4a).
 *
 * Tests the optional `options.recentFilePaths` parameter that biases
 * file selection toward recently-interacted files.
 *
 * Trust boundary: recentFilePaths are data-root-relative paths from the
 * InteractionContextService. They are intersected with the authorized entry
 * set before use — unauthorized paths are silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataQueryServiceImpl } from '../index.js';
import { FileIndexService } from '../../file-index/index.js';
import type { ManifestDataScope } from '../../../types/manifest.js';
import type { AppLogger } from '../../../types/app-module.js';
import type { LLMService } from '../../../types/llm.js';
import type { DataQueryOptions } from '../../../types/data-query.js';

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors data-query.test.ts helpers)
// ---------------------------------------------------------------------------

function makeTempDir() {
	return join(tmpdir(), `pas-context-hints-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function writeDataFile(dataDir: string, relPath: string, content: string) {
	const fullPath = join(dataDir, relPath);
	await mkdir(join(fullPath, '..'), { recursive: true });
	await writeFile(fullPath, content, 'utf-8');
}

function makeAppScopes(userPaths: string[], sharedPaths: string[]) {
	const toScope = (path: string): ManifestDataScope => ({
		path,
		access: 'read-write' as const,
		description: '',
	});
	return new Map([
		['food', { user: userPaths.map(toScope), shared: sharedPaths.map(toScope) }],
	]);
}

function makeMockLogger(): AppLogger {
	const logger = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	} as AppLogger;
	vi.mocked(logger.child).mockReturnValue(logger);
	return logger;
}

function makeMockLlm(response: string): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(response),
		classify: vi.fn(),
		extractStructured: vi.fn(),
		getModelForTier: vi.fn().mockReturnValue('mock-model'),
	} as unknown as LLMService;
}

interface MockSpaceService {
	listSpaces(): { id: string; members: string[] }[];
	isMember(spaceId: string, userId: string): boolean;
	getSpacesForUser(userId: string): { id: string; members: string[] }[];
}

function makeSpaceService(spaces: { id: string; members: string[] }[]): MockSpaceService {
	return {
		listSpaces: () => spaces,
		isMember: (spaceId: string, userId: string) => {
			const space = spaces.find((s) => s.id === spaceId);
			return space?.members.includes(userId) ?? false;
		},
		getSpacesForUser: (userId: string) =>
			spaces.filter((s) => s.members.includes(userId)),
	};
}

const RECIPE_FILE = `---
title: Chicken Tacos
type: recipe
tags:
  - pas/recipe
entity_keys:
  - chicken
  - tacos
app: food
---
# Chicken Tacos
A delicious taco recipe.`;

const RECEIPT_FILE = `---
title: Costco Receipt 2026-04-10
type: receipt
tags:
  - pas/receipt
entity_keys:
  - costco
app: food
---
## Items
- Chicken $12.99`;

const PRICE_FILE = `---
title: Costco Prices
type: price-list
tags:
  - pas/prices
entity_keys:
  - costco
  - orange
app: food
---
## Prices
- Orange $1.99/lb`;

// ---------------------------------------------------------------------------
// Helper: capture the system prompt passed to LLM.complete()
// ---------------------------------------------------------------------------

function captureSystemPrompt(llm: LLMService): () => string {
	return () => {
		const calls = vi.mocked(llm.complete).mock.calls;
		if (calls.length === 0) return '';
		return calls[0][1]?.systemPrompt ?? '';
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DataQueryService — context hints (recentFilePaths)', () => {
	let dataDir: string;
	let logger: AppLogger;

	beforeEach(async () => {
		dataDir = makeTempDir();
		await mkdir(dataDir, { recursive: true });
		logger = makeMockLogger();
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// 1. Backwards compatibility — no options
	// -------------------------------------------------------------------------

	it('query() with no options behaves identically to before — no [recent interaction] label', async () => {
		await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.md', RECIPE_FILE);
		const fileIndex = new FileIndexService(dataDir, makeAppScopes(['recipes/'], []));
		await fileIndex.rebuild();

		const llm = makeMockLlm('[0]');
		const getSystemPrompt = captureSystemPrompt(llm);
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		const result = await svc.query('show me my taco recipe', 'matt');

		expect(result.empty).toBe(false);
		expect(getSystemPrompt()).not.toContain('[recent interaction]');
	});

	// -------------------------------------------------------------------------
	// 2. Empty recentFilePaths — same behavior as no options
	// -------------------------------------------------------------------------

	it('empty recentFilePaths array has same behavior as no options — no [recent interaction] label', async () => {
		await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.md', RECIPE_FILE);
		const fileIndex = new FileIndexService(dataDir, makeAppScopes(['recipes/'], []));
		await fileIndex.rebuild();

		const llm = makeMockLlm('[0]');
		const getSystemPrompt = captureSystemPrompt(llm);
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		const options: DataQueryOptions = { recentFilePaths: [] };
		const result = await svc.query('show me my taco recipe', 'matt', options);

		expect(result.empty).toBe(false);
		expect(getSystemPrompt()).not.toContain('[recent interaction]');
	});

	// -------------------------------------------------------------------------
	// 3. Matching recentFilePaths get [recent interaction] label
	// -------------------------------------------------------------------------

	it('recentFilePaths matching authorized entries get [recent interaction] label in LLM prompt', async () => {
		await writeDataFile(dataDir, 'users/matt/food/receipts/receipt.md', RECEIPT_FILE);
		await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.md', RECIPE_FILE);
		const fileIndex = new FileIndexService(
			dataDir,
			makeAppScopes(['receipts/', 'recipes/'], []),
		);
		await fileIndex.rebuild();

		const llm = makeMockLlm('[0]');
		const getSystemPrompt = captureSystemPrompt(llm);
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		const options: DataQueryOptions = {
			recentFilePaths: ['users/matt/food/receipts/receipt.md'],
		};
		await svc.query('what did those items cost?', 'matt', options);

		const systemPrompt = getSystemPrompt();
		expect(systemPrompt).toContain('[recent interaction]');
		// The receipt entry must have the label; the recipe must not
		expect(systemPrompt).toMatch(/\[recent interaction\].*receipt/i);
	});

	// -------------------------------------------------------------------------
	// 4. Non-authorized paths are silently dropped — no auth bypass
	// -------------------------------------------------------------------------

	it('recentFilePaths NOT in authorized set are silently dropped — no auth bypass', async () => {
		// Matt's file
		await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.md', RECIPE_FILE);
		// Nina's private file — not authorized for matt
		await writeDataFile(dataDir, 'users/nina/food/receipts/receipt.md', RECEIPT_FILE);

		const fileIndex = new FileIndexService(
			dataDir,
			makeAppScopes(['recipes/', 'receipts/'], []),
		);
		await fileIndex.rebuild();

		const llm = makeMockLlm('[0]');
		const getSystemPrompt = captureSystemPrompt(llm);
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		// Matt tries to pass Nina's receipt as a recent file path hint
		const options: DataQueryOptions = {
			recentFilePaths: ['users/nina/food/receipts/receipt.md'],
		};
		await svc.query('what did those items cost?', 'matt', options);

		const systemPrompt = getSystemPrompt();
		// Nina's receipt must not appear as a priority candidate
		// (it's not in matt's authorized set)
		expect(systemPrompt).not.toContain('[recent interaction]');
		// Specifically: nina's receipt path must not appear in the LLM prompt
		expect(systemPrompt).not.toContain('nina');
	});

	// -------------------------------------------------------------------------
	// 5. Priority candidates bypass Stage B pre-filter (>MAX_CANDIDATES entries)
	// -------------------------------------------------------------------------

	it('priority candidates are included even when Stage B pre-filter would exclude them', async () => {
		// Create 110 recipe files to trigger pre-filter (MAX_CANDIDATES = 100)
		// All entries get generic titles with no keyword overlap for "receipt"
		for (let i = 0; i < 110; i++) {
			const content = `---
title: Recipe ${i}
type: recipe
app: food
entity_keys:
  - ingredient${i}
---
Recipe ${i} content`;
			await writeDataFile(dataDir, `users/matt/food/recipes/recipe${i}.md`, content);
		}

		// Add a receipt file that has NO keyword overlap with "receipt cost" query
		// — in a normal pre-filter it would be buried or dropped if the 100-slot budget
		// is consumed by recipe files with higher keyword overlap scores.
		// We ensure it appears as a priority candidate via recentFilePaths.
		const receiptContent = `---
title: Costco Receipt 2026-04-10
type: receipt
app: food
entity_keys:
  - costco
---
## Items
- Chicken $12.99`;
		await writeDataFile(dataDir, 'users/matt/food/receipts/priority-receipt.md', receiptContent);

		const fileIndex = new FileIndexService(
			dataDir,
			makeAppScopes(['recipes/', 'receipts/'], []),
		);
		await fileIndex.rebuild();

		// LLM always selects ID 0 — we just need to verify the system prompt
		// contains [recent interaction] for the priority file
		const llm = makeMockLlm('[0]');
		const getSystemPrompt = captureSystemPrompt(llm);
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		// Use a question that has zero overlap with "receipt" to ensure the receipt
		// would be dropped by the pre-filter without the hint
		const options: DataQueryOptions = {
			recentFilePaths: ['users/matt/food/receipts/priority-receipt.md'],
		};
		await svc.query('show me ingredient42 and ingredient67', 'matt', options);

		const systemPrompt = getSystemPrompt();
		// The priority receipt file must appear in the LLM prompt with the label
		expect(systemPrompt).toContain('[recent interaction]');
		expect(systemPrompt).toContain('receipt');
	});

	// -------------------------------------------------------------------------
	// 6. Non-priority candidates still appear in the prompt (LLM still selects)
	// -------------------------------------------------------------------------

	it('LLM still selects files — hints bias but do not bypass LLM stage', async () => {
		await writeDataFile(dataDir, 'users/matt/food/receipts/receipt.md', RECEIPT_FILE);
		await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.md', RECIPE_FILE);
		await writeDataFile(dataDir, 'users/matt/food/prices/costco.md', PRICE_FILE);
		const fileIndex = new FileIndexService(
			dataDir,
			makeAppScopes(['receipts/', 'recipes/', 'prices/'], []),
		);
		await fileIndex.rebuild();

		// LLM returns empty — simulating it chose not to select the priority file
		const llm = makeMockLlm('[]');
		const svc = new DataQueryServiceImpl({
			fileIndex,
			spaceService: makeSpaceService([]),
			llm,
			dataDir,
			logger,
		});

		const options: DataQueryOptions = {
			recentFilePaths: ['users/matt/food/receipts/receipt.md'],
		};
		const result = await svc.query('show me my recipes', 'matt', options);

		// LLM returned [] → result is empty even though receipt was a priority hint
		expect(result.empty).toBe(true);
		// LLM was still called (hints don't bypass Stage C)
		expect(vi.mocked(llm.complete)).toHaveBeenCalledOnce();
	});
});
