/**
 * Q2(c) — recent-interaction hints must line up with FileIndex paths.
 *
 * Food records `filePaths` after each write; DataQuery matches them by exact
 * string equality against FileIndex entry paths, which use the household
 * layout (`households/<hh>/shared/food/...`). This test drives each real Food
 * recording site with a REAL InteractionContextService, builds a REAL
 * FileIndex over a temp data dir laid out like production, and asserts the
 * REAL DataQueryServiceImpl flags the file as `[recent interaction]`.
 * Only the LLM and the Food stores are mocked.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockCoreServices } from '@pas/core/testing';
import { createTestMessageContext } from '@pas/core/testing/helpers';
import type { CoreServices, PhotoContext } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { requestContext } from '../../../../core/src/services/context/request-context.js';
import { extractRecentFilePaths } from '../../../../core/src/services/conversation/data-query-context.js';
import { DataQueryServiceImpl } from '../../../../core/src/services/data-query/index.js';
import { FileIndexService } from '../../../../core/src/services/file-index/index.js';
import { InteractionContextServiceImpl } from '../../../../core/src/services/interaction-context/index.js';
import { handlePhoto } from '../handlers/photo.js';
import { handleMessage, init } from '../index.js';
import { __clearShadowDepsForTests } from '../routing/shadow-integration.js';
import type { Household } from '../types.js';

const HH = 'hh1';
const USER = 'user1';

const household: Household = {
	id: HH,
	name: 'Test Household',
	createdBy: USER,
	members: [USER],
	joinCode: 'ABC123',
	createdAt: '2026-01-01T00:00:00.000Z',
};

function mockStore(initial: Record<string, string> = {}) {
	const storage = new Map<string, string>(Object.entries(initial));
	return {
		read: vi.fn(async (p: string) => storage.get(p) ?? null),
		write: vi.fn(async (p: string, c: string) => {
			storage.set(p, c);
		}),
		append: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
		delete: vi.fn(),
		archive: vi.fn().mockResolvedValue(undefined),
	};
}

const noopLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
};

function photoServices(llmJson: string, ic: InteractionContextServiceImpl): CoreServices {
	return {
		llm: {
			complete: vi.fn().mockResolvedValue(llmJson),
			completeWithMeta: vi.fn().mockResolvedValue({ text: llmJson, finishReason: 'stop' }),
			classify: vi.fn(),
			extractStructured: vi.fn(),
		},
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendPhoto: vi.fn().mockResolvedValue(undefined),
			sendOptions: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
			editMessage: vi.fn().mockResolvedValue(undefined),
		},
		data: {
			forShared: vi.fn().mockReturnValue(mockStore({ 'household.yaml': stringify(household) })),
			forSpace: vi.fn().mockReturnValue(mockStore({ 'household.yaml': stringify(household) })),
			forUser: vi.fn().mockReturnValue(mockStore()),
		},
		logger: noopLogger,
		interactionContext: ic,
	} as unknown as CoreServices;
}

function photoCtx(caption: string, overrides: Partial<PhotoContext> = {}): PhotoContext {
	return {
		userId: USER,
		photo: Buffer.from('fake-jpeg-data'),
		caption,
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 1,
		messageId: 2,
		...overrides,
	};
}

const RECIPE_JSON = JSON.stringify({
	title: 'Pasta Bake',
	source: 'homemade',
	ingredients: [{ name: 'pasta', quantity: 200, unit: 'g' }],
	instructions: ['Boil pasta', 'Bake'],
	servings: 4,
	tags: [],
	allergens: [],
});
const RECEIPT_JSON = JSON.stringify({
	store: 'Grocery Store',
	date: '2026-04-05',
	lineItems: [{ name: 'Milk', quantity: 1, unitPrice: 3.99, totalPrice: 3.99 }],
	subtotal: 3.99,
	tax: 0.24,
	total: 4.23,
});
const GROCERY_PHOTO_JSON = JSON.stringify({
	items: [{ name: 'apples', quantity: 6, unit: null }],
	isRecipe: false,
});
const MEAL_PLAN_JSON = JSON.stringify({
	meals: [
		{
			date: '2026-04-21',
			mealType: 'dinner',
			recipeTitle: 'Chicken Tacos',
			description: 'Easy',
			recipeId: null,
			isNew: true,
		},
	],
});

interface Site {
	name: string;
	/** Drives the real Food code path; returns after the interaction was recorded. */
	run(ic: InteractionContextServiceImpl): Promise<void>;
	/** Independent expectation of the FileIndex path (household layout). */
	expectedPath(entityId: string | undefined): string;
}

async function textServices(ic: InteractionContextServiceImpl, llmResponse: string) {
	const services = createMockCoreServices();
	vi.mocked(services.data.forShared).mockReturnValue(
		mockStore({ 'household.yaml': stringify(household) }) as never,
	);
	(services as { interactionContext?: unknown }).interactionContext = ic;
	vi.mocked(services.llm.complete).mockResolvedValue(llmResponse);
	await init(services);
	return services;
}

const SITES: Site[] = [
	{
		name: 'index.ts recipe_saved (text)',
		run: async (ic) => {
			await textServices(ic, RECIPE_JSON);
			await handleMessage?.(
				createTestMessageContext({ text: 'save this recipe: Pasta Bake', userId: USER }),
			);
		},
		expectedPath: (id) => `households/${HH}/shared/food/recipes/${id}.yaml`,
	},
	{
		name: 'index.ts grocery_updated (text)',
		run: async (ic) => {
			await textServices(
				ic,
				JSON.stringify([{ name: 'milk', quantity: 1, unit: 'gallon', department: 'dairy' }]),
			);
			await handleMessage?.(
				createTestMessageContext({ text: 'add milk to grocery list', userId: USER }),
			);
		},
		expectedPath: () => `households/${HH}/shared/food/grocery/active.yaml`,
	},
	{
		name: 'index.ts meal_plan_finalized (text)',
		run: async (ic) => {
			await textServices(ic, MEAL_PLAN_JSON);
			await handleMessage?.(
				createTestMessageContext({ text: 'plan meals for this week', userId: USER }),
			);
		},
		expectedPath: () => `households/${HH}/shared/food/meal-plans/current.yaml`,
	},
	{
		name: 'index.ts price_updated (text)',
		run: async (ic) => {
			await textServices(
				ic,
				JSON.stringify({
					item: 'eggs',
					price: 3.5,
					unit: 'dozen',
					store: 'Costco',
					department: 'dairy',
				}),
			);
			await handleMessage?.(
				createTestMessageContext({ text: 'eggs are $3.50 at costco', userId: USER }),
			);
		},
		expectedPath: () => `households/${HH}/shared/food/prices/costco.md`,
	},
	{
		name: 'photo.ts receipt_captured (shared)',
		run: (ic) => handlePhoto(photoServices(RECEIPT_JSON, ic), photoCtx('grocery receipt')) as never,
		expectedPath: (id) => `households/${HH}/shared/food/receipts/${id}.yaml`,
	},
	{
		name: 'photo.ts receipt_captured (space)',
		run: (ic) =>
			handlePhoto(
				photoServices(RECEIPT_JSON, ic),
				photoCtx('grocery receipt', { spaceId: 'fam', spaceName: 'Fam' }),
			) as never,
		expectedPath: (id) => `households/${HH}/spaces/fam/food/receipts/${id}.yaml`,
	},
	{
		name: 'photo.ts recipe_saved (shared)',
		run: (ic) => handlePhoto(photoServices(RECIPE_JSON, ic), photoCtx('save this recipe')) as never,
		expectedPath: (id) => `households/${HH}/shared/food/recipes/${id}.yaml`,
	},
	{
		name: 'photo.ts grocery_updated (shared)',
		run: (ic) =>
			handlePhoto(photoServices(GROCERY_PHOTO_JSON, ic), photoCtx('add to grocery list')) as never,
		expectedPath: () => `households/${HH}/shared/food/grocery/active.yaml`,
	},
];

// ─── Real FileIndex + DataQuery over a temp household-layout tree ───────────

function makeDataQuery(dataDir: string) {
	const scope = (path: string) => ({ path, access: 'read-write' as const, description: '' });
	const shared = ['recipes/', 'grocery/', 'meal-plans/', 'prices/', 'receipts/'].map(scope);
	const fileIndex = new FileIndexService(dataDir, new Map([['food', { user: [], shared }]]));
	const prompts: string[] = [];
	const llm = {
		complete: vi.fn(),
		completeWithMeta: vi.fn(async (_q: string, opts: { systemPrompt?: string }) => {
			prompts.push(opts.systemPrompt ?? '');
			return { text: '[0]', finishReason: 'stop' };
		}),
		classify: vi.fn(),
		extractStructured: vi.fn(),
		getModelForTier: vi.fn().mockReturnValue('mock'),
	};
	const spaceService = {
		listSpaces: () => [{ id: 'fam', members: [USER] }],
		isMember: (spaceId: string, userId: string) => spaceId === 'fam' && userId === USER,
		getSpacesForUser: () => [{ id: 'fam', members: [USER] }],
	};
	const dq = new DataQueryServiceImpl({
		fileIndex,
		spaceService: spaceService as never,
		llm: llm as never,
		dataDir,
		logger: noopLogger as never,
	});
	return { fileIndex, dq, prompts };
}

async function writeFood(dataDir: string, relPath: string, title: string) {
	const full = join(dataDir, relPath);
	await mkdir(join(full, '..'), { recursive: true });
	await writeFile(full, `---\ntitle: ${title}\napp: food\n---\nbody\n`, 'utf-8');
}

describe('Q2(c) recent-interaction paths match FileIndex (real Food path -> real DataQuery)', () => {
	let dataDir: string;
	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'pas-q2c-'));
	});
	afterEach(async () => {
		__clearShadowDepsForTests();
		await rm(dataDir, { recursive: true, force: true });
	});

	it.each(SITES)('$name', async (site) => {
		const ic = new InteractionContextServiceImpl();
		await requestContext.run({ userId: USER, householdId: HH }, () => site.run(ic));

		const entries = requestContext.run({ userId: USER, householdId: HH }, () => ic.getRecent(USER));
		expect(entries).toHaveLength(1);
		const expected = site.expectedPath(entries[0]?.entityId);
		expect(entries[0]?.filePaths).toEqual([expected]);

		// Production layout: file lives exactly where FileIndex will report it.
		await writeFood(dataDir, expected, 'Target Doc');
		await writeFood(dataDir, `households/${HH}/shared/food/recipes/decoy.yaml`, 'Decoy Doc');
		const { fileIndex, dq, prompts } = makeDataQuery(dataDir);
		await fileIndex.rebuild();
		expect(fileIndex.getEntries().map((e) => e.path)).toContain(expected);

		const hints = extractRecentFilePaths(entries);
		const result = await requestContext.run({ userId: USER, householdId: HH }, () =>
			dq.query('show me that', USER, { recentFilePaths: hints }),
		);
		expect(result.empty).toBe(false);
		const flagged = prompts[0]?.split('\n').filter((l) => l.startsWith('[recent interaction]'));
		expect(flagged).toHaveLength(1);
		expect(flagged?.[0]).toContain('Target Doc');
	});

	it('household boundary: household B never gets a hint for a household A file', async () => {
		const ic = new InteractionContextServiceImpl();
		await requestContext.run({ userId: USER, householdId: HH }, () => SITES[0]?.run(ic));
		const aEntries = requestContext.run({ userId: USER, householdId: HH }, () =>
			ic.getRecent(USER),
		);
		const rel = `shared/food/recipes/${aEntries[0]?.entityId}.yaml`;
		const aPath = `households/${HH}/${rel}`;

		await writeFood(dataDir, aPath, 'A Secret');
		await writeFood(dataDir, `households/hhB/${rel}`, 'B Own');
		const { fileIndex, dq, prompts } = makeDataQuery(dataDir);
		await fileIndex.rebuild();

		// Replay A's hints into B's query (the worst case): B must not see A's file at all,
		// and B's same-named file must not be flagged by A's household-qualified path.
		const B = 'userB';
		await requestContext.run({ userId: B, householdId: 'hhB' }, () =>
			dq.query('show me that', B, { recentFilePaths: extractRecentFilePaths(aEntries) }),
		);
		const prompt = prompts[0] ?? '';
		expect(prompt).not.toContain('A Secret');
		expect(prompt).toContain('B Own');
		expect(prompt).not.toContain('[recent interaction]');

		// And B's own recorder, given the same app-emitted legacy-form string, yields B's path.
		const icB = new InteractionContextServiceImpl();
		requestContext.run({ userId: B, householdId: 'hhB' }, () => {
			icB.record(B, {
				appId: 'food',
				action: 'recipe_saved',
				filePaths: [`users/${rel}`],
			});
			expect(icB.getRecent(B)[0]?.filePaths).toEqual([`households/hhB/${rel}`]);
		});
	});
});
