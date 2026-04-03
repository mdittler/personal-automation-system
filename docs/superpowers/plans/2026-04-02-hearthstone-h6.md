# Hearthstone H6: Leftovers, Freezer, Waste & Perishable Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add food lifecycle management — leftover tracking, freezer inventory, waste logging, and proactive "freeze it or lose it" perishable alerts.

**Architecture:** Three new stores (leftover, freezer, waste) following the existing pantry-store YAML+frontmatter pattern. Three new handler files for callbacks and scheduled jobs. Integration hooks into the existing rating and cook-mode handlers for post-meal leftover prompts.

**Tech Stack:** TypeScript, Vitest, YAML, Telegram inline buttons, LLM (fast tier) for expiry estimation.

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `apps/hearthstone/src/services/leftover-store.ts` | CRUD, formatting, expiry queries for leftovers |
| `apps/hearthstone/src/services/freezer-store.ts` | CRUD, formatting, aging queries for freezer |
| `apps/hearthstone/src/services/waste-store.ts` | Append-only waste log |
| `apps/hearthstone/src/handlers/leftover-handler.ts` | Leftover callbacks + daily check job |
| `apps/hearthstone/src/handlers/freezer-handler.ts` | Freezer callbacks + Monday check job |
| `apps/hearthstone/src/handlers/perishable-handler.ts` | Perishable callbacks + daily pantry check |
| `apps/hearthstone/src/__tests__/services/leftover-store.test.ts` | Unit tests |
| `apps/hearthstone/src/__tests__/services/freezer-store.test.ts` | Unit tests |
| `apps/hearthstone/src/__tests__/services/waste-store.test.ts` | Unit tests |
| `apps/hearthstone/src/__tests__/handlers/leftover-handler.test.ts` | Handler tests |
| `apps/hearthstone/src/__tests__/handlers/freezer-handler.test.ts` | Handler tests |
| `apps/hearthstone/src/__tests__/handlers/perishable-handler.test.ts` | Handler tests |

### Modified Files
| File | Change |
|------|--------|
| `apps/hearthstone/src/types.ts` | Add `WasteLogEntry` interface |
| `apps/hearthstone/src/index.ts` | Add commands, callback routing, intent detection, scheduled job dispatch, pending state maps |
| `apps/hearthstone/src/handlers/rating.ts` | Add post-rating leftover prompt |
| `apps/hearthstone/src/handlers/cook-mode.ts` | Add post-cook leftover prompt |
| `apps/hearthstone/src/services/pantry-store.ts` | Add perishable expiry estimation |

---

## Task 1: Add WasteLogEntry Type

**Files:**
- Modify: `apps/hearthstone/src/types.ts:182`

- [ ] **Step 1: Add the WasteLogEntry interface**

After the `Leftover` interface (line 182), add:

```typescript
// ─── Waste Log Types ────────────────────────────────────────────

export interface WasteLogEntry {
	name: string;
	quantity: string;
	reason: 'expired' | 'spoiled' | 'discarded';
	source: 'leftover' | 'pantry' | 'freezer';
	date: string; // ISO date
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd apps/hearthstone && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/hearthstone/src/types.ts
git commit -m "feat(hearthstone): add WasteLogEntry type for H6"
```

---

## Task 2: Leftover Store — Service Layer

**Files:**
- Create: `apps/hearthstone/src/services/leftover-store.ts`
- Create: `apps/hearthstone/src/__tests__/services/leftover-store.test.ts`

- [ ] **Step 1: Create test directory**

```bash
mkdir -p apps/hearthstone/src/__tests__/services
```

- [ ] **Step 2: Write failing tests for load/save**

Create `apps/hearthstone/src/__tests__/services/leftover-store.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { Leftover } from '../../types.js';
import {
	loadLeftovers,
	saveLeftovers,
	addLeftover,
	updateLeftoverStatus,
	getActiveLeftovers,
	getExpiringLeftovers,
	formatLeftoverList,
	buildLeftoverButtons,
	parseLeftoverInput,
} from '../../services/leftover-store.js';

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'Chili',
		quantity: '~3 servings',
		fromRecipe: 'Beef Chili',
		storedDate: '2026-04-01',
		expiryEstimate: '2026-04-04',
		status: 'active',
		...overrides,
	};
}

function mockStore(readResult: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(readResult),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

describe('leftover-store', () => {
	describe('loadLeftovers', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('leftovers.yaml');
		});

		it('parses { items: [...] } format', async () => {
			const items = [makeLeftover({ name: 'Rice' })];
			const store = mockStore(stringify({ items }));
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Rice');
		});

		it('parses array format', async () => {
			const items = [makeLeftover({ name: 'Soup' })];
			const store = mockStore(stringify(items));
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Soup');
		});

		it('strips frontmatter before parsing', async () => {
			const items = [makeLeftover({ name: 'Pasta' })];
			const yaml = stringify({ items });
			const store = mockStore(`---\ntitle: Leftovers\n---\n${yaml}`);
			const result = await loadLeftovers(store as never);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Pasta');
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::bad{{{');
			const result = await loadLeftovers(store as never);
			expect(result).toEqual([]);
		});
	});

	describe('saveLeftovers', () => {
		it('writes YAML with frontmatter', async () => {
			const store = mockStore();
			const items = [makeLeftover()];
			await saveLeftovers(store as never, items);
			expect(store.write).toHaveBeenCalledWith(
				'leftovers.yaml',
				expect.stringContaining('title: Leftovers'),
			);
			expect(store.write).toHaveBeenCalledWith(
				'leftovers.yaml',
				expect.stringContaining('Chili'),
			);
		});
	});

	describe('addLeftover', () => {
		it('adds a new leftover to the list', () => {
			const existing = [makeLeftover({ name: 'Rice' })];
			const newItem = makeLeftover({ name: 'Soup' });
			const result = addLeftover(existing, newItem);
			expect(result).toHaveLength(2);
			expect(result[1]?.name).toBe('Soup');
		});

		it('updates existing item with same name (case-insensitive)', () => {
			const existing = [makeLeftover({ name: 'Rice', quantity: '1 cup' })];
			const updated = makeLeftover({ name: 'rice', quantity: '2 cups' });
			const result = addLeftover(existing, updated);
			expect(result).toHaveLength(1);
			expect(result[0]?.quantity).toBe('2 cups');
		});
	});

	describe('updateLeftoverStatus', () => {
		it('transitions status at given index', () => {
			const items = [makeLeftover({ name: 'Rice', status: 'active' })];
			const result = updateLeftoverStatus(items, 0, 'used');
			expect(result[0]?.status).toBe('used');
		});

		it('returns unchanged array for invalid index', () => {
			const items = [makeLeftover()];
			const result = updateLeftoverStatus(items, 5, 'used');
			expect(result).toEqual(items);
		});
	});

	describe('getActiveLeftovers', () => {
		it('filters to active only', () => {
			const items = [
				makeLeftover({ name: 'A', status: 'active' }),
				makeLeftover({ name: 'B', status: 'used' }),
				makeLeftover({ name: 'C', status: 'frozen' }),
				makeLeftover({ name: 'D', status: 'active' }),
			];
			const result = getActiveLeftovers(items);
			expect(result).toHaveLength(2);
			expect(result.map((l) => l.name)).toEqual(['A', 'D']);
		});
	});

	describe('getExpiringLeftovers', () => {
		it('returns items expiring within N days', () => {
			const items = [
				makeLeftover({ name: 'Today', expiryEstimate: '2026-04-02', status: 'active' }),
				makeLeftover({ name: 'Tomorrow', expiryEstimate: '2026-04-03', status: 'active' }),
				makeLeftover({ name: 'FarAway', expiryEstimate: '2026-04-10', status: 'active' }),
				makeLeftover({ name: 'Used', expiryEstimate: '2026-04-02', status: 'used' }),
			];
			const result = getExpiringLeftovers(items, 1, '2026-04-02');
			expect(result.map((l) => l.name)).toEqual(['Today', 'Tomorrow']);
		});

		it('includes already-expired items', () => {
			const items = [
				makeLeftover({ name: 'Expired', expiryEstimate: '2026-04-01', status: 'active' }),
			];
			const result = getExpiringLeftovers(items, 1, '2026-04-02');
			expect(result).toHaveLength(1);
		});
	});

	describe('formatLeftoverList', () => {
		it('returns empty message for no items', () => {
			const result = formatLeftoverList([]);
			expect(result).toContain('no leftovers');
		});

		it('formats active leftovers with expiry indicators', () => {
			const items = [
				makeLeftover({ name: 'Chili', quantity: '~3 servings', fromRecipe: 'Beef Chili', storedDate: '2026-03-31', expiryEstimate: '2026-04-03' }),
			];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('Chili');
			expect(result).toContain('~3 servings');
			expect(result).toContain('Beef Chili');
		});

		it('shows warning emoji for items expiring tomorrow', () => {
			const items = [
				makeLeftover({ expiryEstimate: '2026-04-03' }),
			];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('⚠️');
		});

		it('shows danger emoji for items expiring today', () => {
			const items = [
				makeLeftover({ expiryEstimate: '2026-04-02' }),
			];
			const result = formatLeftoverList(items, '2026-04-02');
			expect(result).toContain('❌');
		});
	});

	describe('buildLeftoverButtons', () => {
		it('creates action buttons for each active item', () => {
			const items = [
				makeLeftover({ name: 'Chili', status: 'active' }),
				makeLeftover({ name: 'Rice', status: 'active' }),
			];
			const buttons = buildLeftoverButtons(items);
			// First row: Add button
			expect(buttons[0]?.[0]?.text).toContain('Add');
			// Per-item rows
			expect(buttons[1]?.[0]?.callbackData).toBe('app:hearthstone:lo:use:0');
			expect(buttons[1]?.[1]?.callbackData).toBe('app:hearthstone:lo:freeze:0');
			expect(buttons[1]?.[2]?.callbackData).toBe('app:hearthstone:lo:toss:0');
		});

		it('skips non-active items', () => {
			const items = [
				makeLeftover({ name: 'Used', status: 'used' }),
				makeLeftover({ name: 'Active', status: 'active' }),
			];
			const buttons = buildLeftoverButtons(items);
			// Add button + 1 active item row
			expect(buttons).toHaveLength(2);
		});
	});

	describe('parseLeftoverInput', () => {
		it('extracts name and quantity', () => {
			const result = parseLeftoverInput('chili, about 3 servings', 'Beef Chili', 'America/New_York');
			expect(result.name).toBe('chili');
			expect(result.quantity).toBe('about 3 servings');
			expect(result.fromRecipe).toBe('Beef Chili');
		});

		it('handles name-only input', () => {
			const result = parseLeftoverInput('rice', undefined, 'America/New_York');
			expect(result.name).toBe('rice');
			expect(result.quantity).toBe('some');
			expect(result.fromRecipe).toBeUndefined();
		});

		it('sets storedDate to today', () => {
			const result = parseLeftoverInput('soup', undefined, 'UTC');
			expect(result.storedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/leftover-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement leftover-store.ts**

Create `apps/hearthstone/src/services/leftover-store.ts`:

```typescript
/**
 * Leftover store — CRUD for household leftover tracking.
 *
 * Stored at `leftovers.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { Leftover } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';

const LEFTOVER_PATH = 'leftovers.yaml';

/** Load leftovers, or empty array if none exists. */
export async function loadLeftovers(store: ScopedDataStore): Promise<Leftover[]> {
	const raw = await store.read(LEFTOVER_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as Leftover[];
		if (data && typeof data === 'object' && Array.isArray(data.items))
			return data.items as Leftover[];
		return [];
	} catch {
		return [];
	}
}

/** Save leftovers. */
export async function saveLeftovers(store: ScopedDataStore, items: Leftover[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Leftovers',
		date: isoNow(),
		tags: buildAppTags('hearthstone', 'leftovers'),
		app: 'hearthstone',
	});
	await store.write(LEFTOVER_PATH, fm + stringify({ items }));
}

/** Add a leftover, replacing existing with same name (case-insensitive). */
export function addLeftover(existing: Leftover[], item: Leftover): Leftover[] {
	const result = [...existing];
	const idx = result.findIndex((l) => l.name.toLowerCase() === item.name.toLowerCase());
	if (idx >= 0) {
		result[idx] = item;
	} else {
		result.push(item);
	}
	return result;
}

/** Update status of a leftover by index. Returns new array. */
export function updateLeftoverStatus(
	items: Leftover[],
	index: number,
	status: Leftover['status'],
): Leftover[] {
	if (index < 0 || index >= items.length) return items;
	const result = [...items];
	const item = result[index];
	if (item) result[index] = { ...item, status };
	return result;
}

/** Get only active leftovers. */
export function getActiveLeftovers(items: Leftover[]): Leftover[] {
	return items.filter((l) => l.status === 'active');
}

/**
 * Get active leftovers expiring within N days of today (inclusive).
 * Also includes already-expired items still marked active.
 */
export function getExpiringLeftovers(
	items: Leftover[],
	withinDays: number,
	today: string,
): Leftover[] {
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();
	const cutoff = todayMs + withinDays * 24 * 60 * 60 * 1000;
	return items.filter((l) => {
		if (l.status !== 'active') return false;
		const expiryMs = new Date(`${l.expiryEstimate}T00:00:00Z`).getTime();
		return expiryMs <= cutoff;
	});
}

/** Format a date string as "Mon DD" (e.g., "Apr 1"). */
function formatShortDate(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Get expiry indicator emoji based on days until expiry. */
function expiryIndicator(expiryDate: string, today: string): string {
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();
	const expiryMs = new Date(`${expiryDate}T00:00:00Z`).getTime();
	const daysLeft = Math.floor((expiryMs - todayMs) / (24 * 60 * 60 * 1000));
	if (daysLeft <= 0) return ' ❌';
	if (daysLeft === 1) return ' ⚠️';
	return '';
}

/** Format the leftover list for display. */
export function formatLeftoverList(items: Leftover[], today?: string): string {
	const active = getActiveLeftovers(items);
	if (!active.length) return '🥘 You have no leftovers tracked.';

	const todayStr = today ?? todayDate('UTC');
	const lines: string[] = [`🥘 Leftovers (${active.length} active)\n`];

	for (const item of active) {
		const recipeNote = item.fromRecipe ? ` (from ${item.fromRecipe})` : '';
		const indicator = expiryIndicator(item.expiryEstimate, todayStr);
		lines.push(`• ${item.name} — ${item.quantity}${recipeNote}`);
		lines.push(
			`  📅 Stored ${formatShortDate(item.storedDate)} · Expires ${formatShortDate(item.expiryEstimate)}${indicator}`,
		);
	}

	return lines.join('\n');
}

/** Build inline buttons for leftover management. */
export function buildLeftoverButtons(
	items: Leftover[],
): Array<Array<{ text: string; callbackData: string }>> {
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

	// Add button
	buttons.push([{ text: '➕ Add Leftovers', callbackData: 'app:hearthstone:lo:add' }]);

	// Per-item action rows (active items only, using original index)
	for (let i = 0; i < items.length; i++) {
		if (items[i]?.status !== 'active') continue;
		const name = items[i]!.name.length > 8 ? items[i]!.name.slice(0, 8) + '…' : items[i]!.name;
		buttons.push([
			{ text: `✅ ${name}`, callbackData: `app:hearthstone:lo:use:${i}` },
			{ text: `🧊 ${name}`, callbackData: `app:hearthstone:lo:freeze:${i}` },
			{ text: `🗑 ${name}`, callbackData: `app:hearthstone:lo:toss:${i}` },
		]);
	}

	return buttons;
}

/**
 * Parse user input into a leftover (without expiryEstimate — that needs LLM).
 *
 * Accepts: "chili, about 3 servings" or just "chili".
 * If comma-separated, first part is name, rest is quantity.
 */
export function parseLeftoverInput(
	text: string,
	fromRecipe: string | undefined,
	timezone: string,
): Omit<Leftover, 'expiryEstimate'> {
	const parts = text.split(',').map((s) => s.trim());
	const name = parts[0] ?? text.trim();
	const quantity = parts.length > 1 ? parts.slice(1).join(', ').trim() : 'some';

	return {
		name,
		quantity,
		fromRecipe,
		storedDate: todayDate(timezone),
		status: 'active',
	};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/leftover-store.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/hearthstone/src/services/leftover-store.ts apps/hearthstone/src/__tests__/services/leftover-store.test.ts
git commit -m "feat(hearthstone): add leftover-store service with tests"
```

---

## Task 3: Freezer Store — Service Layer

**Files:**
- Create: `apps/hearthstone/src/services/freezer-store.ts`
- Create: `apps/hearthstone/src/__tests__/services/freezer-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/hearthstone/src/__tests__/services/freezer-store.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { FreezerItem } from '../../types.js';
import {
	loadFreezer,
	saveFreezer,
	addFreezerItem,
	removeFreezerItem,
	getAgingFreezerItems,
	formatFreezerList,
	buildFreezerButtons,
	parseFreezerInput,
} from '../../services/freezer-store.js';

function makeFreezerItem(overrides: Partial<FreezerItem> = {}): FreezerItem {
	return {
		name: 'Chicken breasts',
		quantity: '2 lbs',
		frozenDate: '2026-03-15',
		source: 'purchased',
		...overrides,
	};
}

function mockStore(readResult: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(readResult),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

describe('freezer-store', () => {
	describe('loadFreezer', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('freezer.yaml');
		});

		it('parses { items: [...] } format', async () => {
			const items = [makeFreezerItem({ name: 'Soup' })];
			const store = mockStore(stringify({ items }));
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Soup');
		});

		it('parses array format', async () => {
			const items = [makeFreezerItem()];
			const store = mockStore(stringify(items));
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
		});

		it('strips frontmatter before parsing', async () => {
			const items = [makeFreezerItem({ name: 'Stew' })];
			const store = mockStore(`---\ntitle: Freezer\n---\n${stringify({ items })}`);
			const result = await loadFreezer(store as never);
			expect(result).toHaveLength(1);
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::bad');
			const result = await loadFreezer(store as never);
			expect(result).toEqual([]);
		});
	});

	describe('saveFreezer', () => {
		it('writes YAML with frontmatter', async () => {
			const store = mockStore();
			await saveFreezer(store as never, [makeFreezerItem()]);
			expect(store.write).toHaveBeenCalledWith(
				'freezer.yaml',
				expect.stringContaining('title: Freezer Inventory'),
			);
		});
	});

	describe('addFreezerItem', () => {
		it('adds a new item', () => {
			const existing = [makeFreezerItem({ name: 'Soup' })];
			const result = addFreezerItem(existing, makeFreezerItem({ name: 'Chili' }));
			expect(result).toHaveLength(2);
		});

		it('updates existing item with same name', () => {
			const existing = [makeFreezerItem({ name: 'Soup', quantity: '1 cup' })];
			const result = addFreezerItem(existing, makeFreezerItem({ name: 'soup', quantity: '2 cups' }));
			expect(result).toHaveLength(1);
			expect(result[0]?.quantity).toBe('2 cups');
		});
	});

	describe('removeFreezerItem', () => {
		it('removes item by index', () => {
			const items = [makeFreezerItem({ name: 'A' }), makeFreezerItem({ name: 'B' })];
			const result = removeFreezerItem(items, 0);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('B');
		});

		it('returns unchanged array for invalid index', () => {
			const items = [makeFreezerItem()];
			const result = removeFreezerItem(items, 5);
			expect(result).toEqual(items);
		});
	});

	describe('getAgingFreezerItems', () => {
		it('returns items frozen more than N months ago', () => {
			const items = [
				makeFreezerItem({ name: 'Old', frozenDate: '2025-12-01' }),
				makeFreezerItem({ name: 'Recent', frozenDate: '2026-03-15' }),
			];
			const result = getAgingFreezerItems(items, 3, '2026-04-02');
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Old');
		});
	});

	describe('formatFreezerList', () => {
		it('returns empty message for no items', () => {
			const result = formatFreezerList([]);
			expect(result).toContain('empty');
		});

		it('formats items with age warning', () => {
			const items = [
				makeFreezerItem({ name: 'Old Bread', frozenDate: '2025-12-01' }),
			];
			const result = formatFreezerList(items, '2026-04-02');
			expect(result).toContain('Old Bread');
			expect(result).toContain('⚠️');
		});

		it('shows source info', () => {
			const items = [makeFreezerItem({ source: 'Beef Chili' })];
			const result = formatFreezerList(items);
			expect(result).toContain('Beef Chili');
		});
	});

	describe('buildFreezerButtons', () => {
		it('creates thaw and toss buttons per item', () => {
			const items = [makeFreezerItem({ name: 'Soup' })];
			const buttons = buildFreezerButtons(items);
			expect(buttons[0]?.[0]?.text).toContain('Add');
			expect(buttons[1]?.[0]?.callbackData).toBe('app:hearthstone:fz:thaw:0');
			expect(buttons[1]?.[1]?.callbackData).toBe('app:hearthstone:fz:toss:0');
		});
	});

	describe('parseFreezerInput', () => {
		it('extracts name and quantity', () => {
			const result = parseFreezerInput('2 lbs chicken breasts', 'purchased', 'UTC');
			expect(result.name).toBe('chicken breasts');
			expect(result.quantity).toBe('2 lbs');
			expect(result.source).toBe('purchased');
		});

		it('handles name-only input', () => {
			const result = parseFreezerInput('soup', undefined, 'UTC');
			expect(result.name).toBe('soup');
			expect(result.quantity).toBe('some');
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/freezer-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement freezer-store.ts**

Create `apps/hearthstone/src/services/freezer-store.ts`:

```typescript
/**
 * Freezer store — CRUD for household freezer inventory.
 *
 * Stored at `freezer.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { FreezerItem } from '../types.js';
import { isoNow, todayDate } from '../utils/date.js';

const FREEZER_PATH = 'freezer.yaml';

/** Load freezer items, or empty array if none exists. */
export async function loadFreezer(store: ScopedDataStore): Promise<FreezerItem[]> {
	const raw = await store.read(FREEZER_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as FreezerItem[];
		if (data && typeof data === 'object' && Array.isArray(data.items))
			return data.items as FreezerItem[];
		return [];
	} catch {
		return [];
	}
}

/** Save freezer items. */
export async function saveFreezer(store: ScopedDataStore, items: FreezerItem[]): Promise<void> {
	const fm = generateFrontmatter({
		title: 'Freezer Inventory',
		date: isoNow(),
		tags: buildAppTags('hearthstone', 'freezer'),
		app: 'hearthstone',
	});
	await store.write(FREEZER_PATH, fm + stringify({ items }));
}

/** Add a freezer item, replacing existing with same name. */
export function addFreezerItem(existing: FreezerItem[], item: FreezerItem): FreezerItem[] {
	const result = [...existing];
	const idx = result.findIndex((f) => f.name.toLowerCase() === item.name.toLowerCase());
	if (idx >= 0) {
		result[idx] = item;
	} else {
		result.push(item);
	}
	return result;
}

/** Remove a freezer item by index. */
export function removeFreezerItem(items: FreezerItem[], index: number): FreezerItem[] {
	if (index < 0 || index >= items.length) return items;
	return [...items.slice(0, index), ...items.slice(index + 1)];
}

/** Get items frozen more than N months ago. */
export function getAgingFreezerItems(
	items: FreezerItem[],
	olderThanMonths: number,
	today: string,
): FreezerItem[] {
	const todayDate = new Date(`${today}T00:00:00Z`);
	const cutoff = new Date(todayDate);
	cutoff.setUTCMonth(cutoff.getUTCMonth() - olderThanMonths);
	const cutoffMs = cutoff.getTime();

	return items.filter((f) => {
		const frozenMs = new Date(`${f.frozenDate}T00:00:00Z`).getTime();
		return frozenMs <= cutoffMs;
	});
}

/** Format a date string as "Mon DD". */
function formatShortDate(dateStr: string): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Get age description and warning for a frozen item. */
function ageInfo(frozenDate: string, today: string): string {
	const frozenMs = new Date(`${frozenDate}T00:00:00Z`).getTime();
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();
	const months = Math.floor((todayMs - frozenMs) / (30.44 * 24 * 60 * 60 * 1000));
	if (months >= 3) return ` ⚠️ ${months}+ months`;
	return '';
}

/** Format the freezer inventory for display. */
export function formatFreezerList(items: FreezerItem[], today?: string): string {
	if (!items.length) return '🧊 Your freezer is empty.';

	const todayStr = today ?? todayDate('UTC');
	const lines: string[] = [`🧊 Freezer (${items.length} items)\n`];

	for (const item of items) {
		const sourceNote = item.source ? ` (${item.source})` : '';
		const age = ageInfo(item.frozenDate, todayStr);
		lines.push(`• ${item.name} — ${item.quantity}${sourceNote}`);
		lines.push(`  📅 Frozen ${formatShortDate(item.frozenDate)}${age}`);
	}

	return lines.join('\n');
}

/** Build inline buttons for freezer management. */
export function buildFreezerButtons(
	items: FreezerItem[],
): Array<Array<{ text: string; callbackData: string }>> {
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];

	buttons.push([{ text: '➕ Add to Freezer', callbackData: 'app:hearthstone:fz:add' }]);

	for (let i = 0; i < items.length; i++) {
		const name = items[i]!.name.length > 10 ? items[i]!.name.slice(0, 10) + '…' : items[i]!.name;
		buttons.push([
			{ text: `🔥 ${name}`, callbackData: `app:hearthstone:fz:thaw:${i}` },
			{ text: `🗑 ${name}`, callbackData: `app:hearthstone:fz:toss:${i}` },
		]);
	}

	return buttons;
}

/** Regex to extract quantity+unit prefix from freezer items. */
const FREEZER_QTY_REGEX =
	/^(\d+(?:\.\d+)?)\s*(lbs?|oz|cups?|servings?|containers?|bags?|pieces?|portions?|slices?|loaves?|loaf)\s+/i;

/**
 * Parse user input into a freezer item.
 * Accepts: "2 lbs chicken breasts" or just "soup".
 */
export function parseFreezerInput(
	text: string,
	source: string | undefined,
	timezone: string,
): FreezerItem {
	const trimmed = text.trim();
	const match = trimmed.match(FREEZER_QTY_REGEX);

	let name: string;
	let quantity: string;

	if (match?.[0]) {
		const qty = match[1] ?? '';
		const unit = match[2] ?? '';
		name = trimmed.slice(match[0].length).trim();
		quantity = [qty, unit].filter(Boolean).join(' ') || 'some';
		if (!name) {
			name = trimmed;
			quantity = 'some';
		}
	} else {
		name = trimmed;
		quantity = 'some';
	}

	return {
		name,
		quantity,
		frozenDate: todayDate(timezone),
		source,
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/freezer-store.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/freezer-store.ts apps/hearthstone/src/__tests__/services/freezer-store.test.ts
git commit -m "feat(hearthstone): add freezer-store service with tests"
```

---

## Task 4: Waste Store — Service Layer

**Files:**
- Create: `apps/hearthstone/src/services/waste-store.ts`
- Create: `apps/hearthstone/src/__tests__/services/waste-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/hearthstone/src/__tests__/services/waste-store.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { WasteLogEntry } from '../../types.js';
import {
	loadWasteLog,
	appendWaste,
	formatWasteSummary,
} from '../../services/waste-store.js';

function makeWasteEntry(overrides: Partial<WasteLogEntry> = {}): WasteLogEntry {
	return {
		name: 'Soup',
		quantity: '1 container',
		reason: 'expired',
		source: 'leftover',
		date: '2026-04-01',
		...overrides,
	};
}

function mockStore(readResult: string | null = null) {
	return {
		read: vi.fn().mockResolvedValue(readResult),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

describe('waste-store', () => {
	describe('loadWasteLog', () => {
		it('returns empty array when store has no file', async () => {
			const store = mockStore(null);
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
			expect(store.read).toHaveBeenCalledWith('waste-log.yaml');
		});

		it('parses { entries: [...] } format', async () => {
			const entries = [makeWasteEntry()];
			const store = mockStore(stringify({ entries }));
			const result = await loadWasteLog(store as never);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe('Soup');
		});

		it('strips frontmatter', async () => {
			const entries = [makeWasteEntry({ name: 'Rice' })];
			const store = mockStore(`---\ntitle: Waste\n---\n${stringify({ entries })}`);
			const result = await loadWasteLog(store as never);
			expect(result).toHaveLength(1);
		});

		it('returns empty array for malformed YAML', async () => {
			const store = mockStore(':::bad');
			const result = await loadWasteLog(store as never);
			expect(result).toEqual([]);
		});
	});

	describe('appendWaste', () => {
		it('adds entry to empty log', async () => {
			const store = mockStore(null);
			await appendWaste(store as never, makeWasteEntry());
			expect(store.write).toHaveBeenCalledWith(
				'waste-log.yaml',
				expect.stringContaining('Soup'),
			);
		});

		it('appends to existing entries', async () => {
			const existing = [makeWasteEntry({ name: 'Old' })];
			const store = mockStore(stringify({ entries: existing }));
			await appendWaste(store as never, makeWasteEntry({ name: 'New' }));
			const written = store.write.mock.calls[0]?.[1] as string;
			expect(written).toContain('Old');
			expect(written).toContain('New');
		});
	});

	describe('formatWasteSummary', () => {
		it('returns empty message for no entries', () => {
			const result = formatWasteSummary([], 30);
			expect(result).toContain('No food waste');
		});

		it('formats entries with counts', () => {
			const entries = [
				makeWasteEntry({ name: 'Soup', reason: 'expired', source: 'leftover' }),
				makeWasteEntry({ name: 'Milk', reason: 'spoiled', source: 'pantry' }),
			];
			const result = formatWasteSummary(entries, 30);
			expect(result).toContain('Soup');
			expect(result).toContain('Milk');
			expect(result).toContain('2');
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/waste-store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement waste-store.ts**

Create `apps/hearthstone/src/services/waste-store.ts`:

```typescript
/**
 * Waste store — append-only log of food waste.
 *
 * Stored at `waste-log.yaml` in shared scope.
 */

import type { ScopedDataStore } from '@pas/core/types';
import { buildAppTags, generateFrontmatter, stripFrontmatter } from '@pas/core/utils/frontmatter';
import { parse, stringify } from 'yaml';
import type { WasteLogEntry } from '../types.js';
import { isoNow } from '../utils/date.js';

const WASTE_PATH = 'waste-log.yaml';

/** Load waste log entries, or empty array if none exists. */
export async function loadWasteLog(store: ScopedDataStore): Promise<WasteLogEntry[]> {
	const raw = await store.read(WASTE_PATH);
	if (!raw) return [];
	try {
		const content = stripFrontmatter(raw);
		const data = parse(content);
		if (Array.isArray(data)) return data as WasteLogEntry[];
		if (data && typeof data === 'object' && Array.isArray(data.entries))
			return data.entries as WasteLogEntry[];
		return [];
	} catch {
		return [];
	}
}

/** Append a waste entry to the log. Loads existing entries, appends, saves. */
export async function appendWaste(store: ScopedDataStore, entry: WasteLogEntry): Promise<void> {
	const existing = await loadWasteLog(store);
	existing.push(entry);
	const fm = generateFrontmatter({
		title: 'Food Waste Log',
		date: isoNow(),
		tags: buildAppTags('hearthstone', 'waste'),
		app: 'hearthstone',
	});
	await store.write(WASTE_PATH, fm + stringify({ entries: existing }));
}

/** Format a summary of waste entries over a given period. */
export function formatWasteSummary(entries: WasteLogEntry[], _periodDays: number): string {
	if (!entries.length) return '🗑 No food waste logged.';

	const lines: string[] = [`🗑 Food Waste Log (${entries.length} items)\n`];

	for (const entry of entries) {
		const reason = entry.reason === 'expired' ? '⏰' : entry.reason === 'spoiled' ? '🤢' : '🗑';
		lines.push(`${reason} ${entry.name} — ${entry.quantity} (${entry.source}, ${entry.reason})`);
	}

	return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/services/waste-store.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/waste-store.ts apps/hearthstone/src/__tests__/services/waste-store.test.ts
git commit -m "feat(hearthstone): add waste-store service with tests"
```

---

## Task 5: Leftover Handler — Callbacks + Daily Check Job

**Files:**
- Create: `apps/hearthstone/src/handlers/leftover-handler.ts`
- Create: `apps/hearthstone/src/__tests__/handlers/leftover-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/hearthstone/src/__tests__/handlers/leftover-handler.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { stringify } from 'yaml';
import type { Leftover, WasteLogEntry } from '../../types.js';
import {
	handleLeftoverCallback,
	handleLeftoverCheckJob,
} from '../../handlers/leftover-handler.js';

function makeLeftover(overrides: Partial<Leftover> = {}): Leftover {
	return {
		name: 'Chili',
		quantity: '~3 servings',
		fromRecipe: 'Beef Chili',
		storedDate: '2026-04-01',
		expiryEstimate: '2026-04-04',
		status: 'active',
		...overrides,
	};
}

function mockStore(data: Record<string, string | null> = {}) {
	const storage = new Map(Object.entries(data));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => { storage.set(path, content); }),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

function mockServices(store: ReturnType<typeof mockStore>, household: { members: string[] } | null = { members: ['user1'] }) {
	return {
		data: {
			forShared: vi.fn().mockReturnValue(store),
		},
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue({ messageId: 1, chatId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		timezone: 'UTC',
		llm: {
			complete: vi.fn().mockResolvedValue('3'),
		},
		config: {
			get: vi.fn().mockResolvedValue(undefined),
		},
	} as unknown;
}

describe('leftover-handler', () => {
	describe('handleLeftoverCallback', () => {
		it('marks leftover as used on use:<idx> action', async () => {
			const items = [makeLeftover({ name: 'Chili', status: 'active' })];
			const store = mockStore({ 'leftovers.yaml': stringify({ items }) });
			const services = mockServices(store);

			await handleLeftoverCallback(
				services as never, 'use:0', 'user1', 123, 456, store as never,
			);

			expect(store.write).toHaveBeenCalled();
			const written = store.write.mock.calls[0]?.[1] as string;
			expect(written).toContain('used');
			expect(services.telegram.editMessage).toHaveBeenCalled();
		});

		it('freezes leftover and creates freezer item on freeze:<idx>', async () => {
			const items = [makeLeftover({ name: 'Chili', quantity: '3 servings', fromRecipe: 'Beef Chili' })];
			const store = mockStore({
				'leftovers.yaml': stringify({ items }),
				'freezer.yaml': stringify({ items: [] }),
			});
			const services = mockServices(store);

			await handleLeftoverCallback(
				services as never, 'freeze:0', 'user1', 123, 456, store as never,
			);

			// Leftover should be marked frozen
			const leftoverWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'leftovers.yaml')?.[1] as string;
			expect(leftoverWritten).toContain('frozen');

			// Freezer should have new item
			const freezerWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'freezer.yaml')?.[1] as string;
			expect(freezerWritten).toContain('Chili');
		});

		it('marks leftover as wasted and logs waste on toss:<idx>', async () => {
			const items = [makeLeftover({ name: 'Soup', quantity: '1 cup' })];
			const store = mockStore({
				'leftovers.yaml': stringify({ items }),
			});
			const services = mockServices(store);

			await handleLeftoverCallback(
				services as never, 'toss:0', 'user1', 123, 456, store as never,
			);

			// Leftover marked wasted
			const leftoverWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'leftovers.yaml')?.[1] as string;
			expect(leftoverWritten).toContain('wasted');

			// Waste log entry created
			const wasteWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'waste-log.yaml')?.[1] as string;
			expect(wasteWritten).toContain('Soup');
			expect(wasteWritten).toContain('discarded');
		});
	});

	describe('handleLeftoverCheckJob', () => {
		it('auto-wastes expired leftovers', async () => {
			const items = [
				makeLeftover({ name: 'Expired', expiryEstimate: '2026-04-01', status: 'active' }),
				makeLeftover({ name: 'Fresh', expiryEstimate: '2026-04-10', status: 'active' }),
			];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'leftovers.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handleLeftoverCheckJob(services as never, '2026-04-02');

			// Expired item should be wasted
			const leftoverWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'leftovers.yaml')?.[1] as string;
			expect(leftoverWritten).toContain('wasted');

			// Waste log should have entry
			const wasteWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'waste-log.yaml')?.[1] as string;
			expect(wasteWritten).toContain('Expired');

			// Alert sent to household
			expect(services.telegram.sendWithButtons).toHaveBeenCalled();
		});

		it('sends no alert when no active leftovers', async () => {
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'leftovers.yaml': stringify({ items: [] }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handleLeftoverCheckJob(services as never, '2026-04-02');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
			expect(services.telegram.send).not.toHaveBeenCalled();
		});

		it('skips when no household exists', async () => {
			const store = mockStore({});
			const services = mockServices(store, null);

			await handleLeftoverCheckJob(services as never, '2026-04-02');

			expect(store.write).not.toHaveBeenCalled();
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/leftover-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement leftover-handler.ts**

Create `apps/hearthstone/src/handlers/leftover-handler.ts`:

```typescript
/**
 * Leftover handler — callbacks for leftover management and daily check job.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import {
	addLeftover,
	buildLeftoverButtons,
	formatLeftoverList,
	getActiveLeftovers,
	loadLeftovers,
	saveLeftovers,
	updateLeftoverStatus,
} from '../services/leftover-store.js';
import { addFreezerItem, loadFreezer, saveFreezer } from '../services/freezer-store.js';
import { appendWaste } from '../services/waste-store.js';
import type { FreezerItem, Leftover, WasteLogEntry } from '../types.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

/**
 * Handle leftover callback actions.
 *
 * Actions: use:<idx>, freeze:<idx>, toss:<idx>, add, keep:<idx>,
 *          post-meal:yes, post-meal:no
 */
export async function handleLeftoverCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	if (action.startsWith('use:')) {
		const idx = Number.parseInt(action.slice(4), 10);
		if (Number.isNaN(idx)) return;
		let items = await loadLeftovers(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;
		items = updateLeftoverStatus(items, idx, 'used');
		await saveLeftovers(store, items);
		await services.telegram.editMessage(chatId, messageId, `✅ Used: ${item.name}`);
		return;
	}

	if (action.startsWith('freeze:')) {
		const idx = Number.parseInt(action.slice(7), 10);
		if (Number.isNaN(idx)) return;
		let items = await loadLeftovers(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;
		items = updateLeftoverStatus(items, idx, 'frozen');
		await saveLeftovers(store, items);

		// Create freezer item
		const freezerItem: FreezerItem = {
			name: item.name,
			quantity: item.quantity,
			frozenDate: todayDate(services.timezone),
			source: item.fromRecipe ?? 'leftover',
		};
		const freezerItems = await loadFreezer(store);
		await saveFreezer(store, addFreezerItem(freezerItems, freezerItem));

		await services.telegram.editMessage(chatId, messageId, `🧊 Frozen: ${item.name}`);
		return;
	}

	if (action.startsWith('toss:')) {
		const idx = Number.parseInt(action.slice(5), 10);
		if (Number.isNaN(idx)) return;
		let items = await loadLeftovers(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;
		items = updateLeftoverStatus(items, idx, 'wasted');
		await saveLeftovers(store, items);

		// Log waste
		const entry: WasteLogEntry = {
			name: item.name,
			quantity: item.quantity,
			reason: 'discarded',
			source: 'leftover',
			date: todayDate(services.timezone),
		};
		await appendWaste(store, entry);

		await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
		return;
	}

	if (action.startsWith('keep:')) {
		// Dismiss alert — no data change
		const idx = Number.parseInt(action.slice(5), 10);
		if (Number.isNaN(idx)) return;
		const items = await loadLeftovers(store);
		const item = items[idx];
		const name = item?.name ?? 'item';
		await services.telegram.editMessage(chatId, messageId, `✅ Got it — keeping ${name}`);
		return;
	}

	if (action === 'post-meal:no') {
		await services.telegram.editMessage(chatId, messageId, 'No leftovers — noted!');
		return;
	}
}

/**
 * Daily 10am leftover check job.
 *
 * 1. Auto-waste expired leftovers
 * 2. Alert on items expiring today/tomorrow with action buttons
 */
export async function handleLeftoverCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	let items = await loadLeftovers(sharedStore);
	const active = getActiveLeftovers(items);
	if (!active.length) return;

	const today = todayOverride ?? todayDate(services.timezone);
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();

	const expired: Leftover[] = [];
	const expiringToday: Array<{ item: Leftover; idx: number }> = [];
	const expiringTomorrow: Array<{ item: Leftover; idx: number }> = [];

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (item.status !== 'active') continue;
		const expiryMs = new Date(`${item.expiryEstimate}T00:00:00Z`).getTime();
		const daysLeft = Math.floor((expiryMs - todayMs) / (24 * 60 * 60 * 1000));

		if (daysLeft < 0) {
			expired.push(item);
			items = updateLeftoverStatus(items, i, 'wasted');
			const entry: WasteLogEntry = {
				name: item.name,
				quantity: item.quantity,
				reason: 'expired',
				source: 'leftover',
				date: today,
			};
			await appendWaste(sharedStore, entry);
		} else if (daysLeft === 0) {
			expiringToday.push({ item, idx: i });
		} else if (daysLeft === 1) {
			expiringTomorrow.push({ item, idx: i });
		}
	}

	// Save updated statuses (expired → wasted)
	if (expired.length > 0) {
		await saveLeftovers(sharedStore, items);
	}

	// Only send alert if there's something to report
	if (!expired.length && !expiringToday.length && !expiringTomorrow.length) return;

	// Build alert message
	const lines: string[] = ['⚠️ Leftovers Alert!\n'];

	if (expired.length) {
		lines.push('❌ Expired (logged as waste):');
		for (const item of expired) {
			const recipeNote = item.fromRecipe ? ` (from ${item.fromRecipe})` : '';
			lines.push(`• ${item.name} — ${item.quantity}${recipeNote}`);
		}
		lines.push('');
	}

	if (expiringToday.length) {
		lines.push('🔥 Use today or freeze:');
		for (const { item } of expiringToday) {
			const recipeNote = item.fromRecipe ? ` (from ${item.fromRecipe})` : '';
			lines.push(`• ${item.name} — ${item.quantity}${recipeNote}`);
		}
		lines.push('');
	}

	if (expiringTomorrow.length) {
		lines.push('⏰ Expiring tomorrow:');
		for (const { item } of expiringTomorrow) {
			const recipeNote = item.fromRecipe ? ` (from ${item.fromRecipe})` : '';
			lines.push(`• ${item.name} — ${item.quantity}${recipeNote}`);
		}
	}

	// Build action buttons for expiring items
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
	for (const { item, idx } of expiringToday) {
		const name = item.name.length > 8 ? item.name.slice(0, 8) + '…' : item.name;
		buttons.push([
			{ text: `🧊 Freeze ${name}`, callbackData: `app:hearthstone:lo:freeze:${idx}` },
			{ text: `✅ Eat ${name}`, callbackData: `app:hearthstone:lo:keep:${idx}` },
			{ text: `🗑 Toss ${name}`, callbackData: `app:hearthstone:lo:toss:${idx}` },
		]);
	}
	for (const { item, idx } of expiringTomorrow) {
		const name = item.name.length > 8 ? item.name.slice(0, 8) + '…' : item.name;
		buttons.push([
			{ text: `🧊 Freeze ${name}`, callbackData: `app:hearthstone:lo:freeze:${idx}` },
			{ text: `✅ Got it`, callbackData: `app:hearthstone:lo:keep:${idx}` },
		]);
	}

	const message = lines.join('\n').trimEnd();

	for (const memberId of household.members) {
		if (buttons.length) {
			await services.telegram.sendWithButtons(memberId, message, buttons);
		} else {
			await services.telegram.send(memberId, message);
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/leftover-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/leftover-handler.ts apps/hearthstone/src/__tests__/handlers/leftover-handler.test.ts
git commit -m "feat(hearthstone): add leftover handler with callbacks and daily check job"
```

---

## Task 6: Freezer Handler — Callbacks + Monday Check Job

**Files:**
- Create: `apps/hearthstone/src/handlers/freezer-handler.ts`
- Create: `apps/hearthstone/src/__tests__/handlers/freezer-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/hearthstone/src/__tests__/handlers/freezer-handler.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { FreezerItem } from '../../types.js';
import {
	handleFreezerCallback,
	handleFreezerCheckJob,
} from '../../handlers/freezer-handler.js';

function makeFreezerItem(overrides: Partial<FreezerItem> = {}): FreezerItem {
	return {
		name: 'Chicken',
		quantity: '2 lbs',
		frozenDate: '2026-03-15',
		source: 'purchased',
		...overrides,
	};
}

function mockStore(data: Record<string, string | null> = {}) {
	const storage = new Map(Object.entries(data));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => { storage.set(path, content); }),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

function mockServices(store: ReturnType<typeof mockStore>) {
	return {
		data: {
			forShared: vi.fn().mockReturnValue(store),
		},
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue({ messageId: 1, chatId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		timezone: 'UTC',
	} as unknown;
}

describe('freezer-handler', () => {
	describe('handleFreezerCallback', () => {
		it('removes item on thaw:<idx>', async () => {
			const items = [makeFreezerItem({ name: 'Soup' })];
			const store = mockStore({ 'freezer.yaml': stringify({ items }) });
			const services = mockServices(store);

			await handleFreezerCallback(
				services as never, 'thaw:0', 'user1', 123, 456, store as never,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456, expect.stringContaining('Thawed'),
			);
		});

		it('removes item and logs waste on toss:<idx>', async () => {
			const items = [makeFreezerItem({ name: 'Old Bread' })];
			const store = mockStore({ 'freezer.yaml': stringify({ items }) });
			const services = mockServices(store);

			await handleFreezerCallback(
				services as never, 'toss:0', 'user1', 123, 456, store as never,
			);

			// Waste log should be written
			const wasteWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'waste-log.yaml')?.[1] as string;
			expect(wasteWritten).toContain('Old Bread');
			expect(wasteWritten).toContain('discarded');
		});
	});

	describe('handleFreezerCheckJob', () => {
		it('sends reminder for items frozen 3+ months', async () => {
			const items = [
				makeFreezerItem({ name: 'Old Soup', frozenDate: '2025-12-01' }),
				makeFreezerItem({ name: 'Recent', frozenDate: '2026-03-15' }),
			];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'freezer.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handleFreezerCheckJob(services as never, '2026-04-02');

			expect(services.telegram.send).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('Old Soup'),
			);
		});

		it('sends no message when no aging items', async () => {
			const items = [makeFreezerItem({ frozenDate: '2026-03-15' })];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'freezer.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handleFreezerCheckJob(services as never, '2026-04-02');

			expect(services.telegram.send).not.toHaveBeenCalled();
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/freezer-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement freezer-handler.ts**

Create `apps/hearthstone/src/handlers/freezer-handler.ts`:

```typescript
/**
 * Freezer handler — callbacks for freezer management and Monday check job.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import {
	buildFreezerButtons,
	formatFreezerList,
	getAgingFreezerItems,
	loadFreezer,
	removeFreezerItem,
	saveFreezer,
} from '../services/freezer-store.js';
import { appendWaste } from '../services/waste-store.js';
import type { WasteLogEntry } from '../types.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

/**
 * Handle freezer callback actions.
 *
 * Actions: thaw:<idx>, toss:<idx>, add
 */
export async function handleFreezerCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	if (action.startsWith('thaw:')) {
		const idx = Number.parseInt(action.slice(5), 10);
		if (Number.isNaN(idx)) return;
		const items = await loadFreezer(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;
		const updated = removeFreezerItem(items, idx);
		await saveFreezer(store, updated);
		await services.telegram.editMessage(chatId, messageId, `🔥 Thawed: ${item.name}`);
		return;
	}

	if (action.startsWith('toss:')) {
		const idx = Number.parseInt(action.slice(5), 10);
		if (Number.isNaN(idx)) return;
		const items = await loadFreezer(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;
		const updated = removeFreezerItem(items, idx);
		await saveFreezer(store, updated);

		const entry: WasteLogEntry = {
			name: item.name,
			quantity: item.quantity,
			reason: 'discarded',
			source: 'freezer',
			date: todayDate(services.timezone),
		};
		await appendWaste(store, entry);

		await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
		return;
	}
}

/**
 * Monday 9am freezer check job.
 *
 * Sends informational reminder about items frozen 3+ months.
 */
export async function handleFreezerCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const items = await loadFreezer(sharedStore);
	if (!items.length) return;

	const today = todayOverride ?? todayDate(services.timezone);
	const aging = getAgingFreezerItems(items, 3, today);
	if (!aging.length) return;

	const lines: string[] = ['🧊 Freezer Check\n'];
	lines.push('These items have been frozen a while — consider using them soon:\n');

	for (const item of aging) {
		const frozenMs = new Date(`${item.frozenDate}T00:00:00Z`).getTime();
		const todayMs = new Date(`${today}T00:00:00Z`).getTime();
		const months = Math.floor((todayMs - frozenMs) / (30.44 * 24 * 60 * 60 * 1000));
		const d = new Date(`${item.frozenDate}T00:00:00Z`);
		const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
		lines.push(`• ${item.name} — frozen ${months}+ months (${dateStr})`);
	}

	lines.push('\nUse /freezer to manage your inventory.');

	const message = lines.join('\n');
	for (const memberId of household.members) {
		await services.telegram.send(memberId, message);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/freezer-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/freezer-handler.ts apps/hearthstone/src/__tests__/handlers/freezer-handler.test.ts
git commit -m "feat(hearthstone): add freezer handler with callbacks and Monday check job"
```

---

## Task 7: Perishable Handler — Callbacks + Daily Pantry Check Job

**Files:**
- Create: `apps/hearthstone/src/handlers/perishable-handler.ts`
- Create: `apps/hearthstone/src/__tests__/handlers/perishable-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/hearthstone/src/__tests__/handlers/perishable-handler.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { PantryItem } from '../../types.js';
import {
	handlePerishableCallback,
	handlePerishableCheckJob,
} from '../../handlers/perishable-handler.js';

function makePantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
	return {
		name: 'Chicken breasts',
		quantity: '1 lb',
		addedDate: '2026-03-28',
		expiryEstimate: '2026-04-03',
		category: 'Meat & Seafood',
		...overrides,
	};
}

function mockStore(data: Record<string, string | null> = {}) {
	const storage = new Map(Object.entries(data));
	return {
		read: vi.fn(async (path: string) => storage.get(path) ?? null),
		write: vi.fn(async (path: string, content: string) => { storage.set(path, content); }),
		append: vi.fn(),
		list: vi.fn(),
		exists: vi.fn(),
		archive: vi.fn(),
	};
}

function mockServices(store: ReturnType<typeof mockStore>) {
	return {
		data: {
			forShared: vi.fn().mockReturnValue(store),
		},
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue({ messageId: 1, chatId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		timezone: 'UTC',
	} as unknown;
}

describe('perishable-handler', () => {
	describe('handlePerishableCallback', () => {
		it('moves pantry item to freezer on freeze:<idx>', async () => {
			const items = [makePantryItem({ name: 'Chicken' })];
			const store = mockStore({
				'pantry.yaml': stringify({ items }),
				'freezer.yaml': stringify({ items: [] }),
			});
			const services = mockServices(store);

			await handlePerishableCallback(
				services as never, 'freeze:0', 'user1', 123, 456, store as never,
			);

			// Pantry should have item removed
			const pantryWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'pantry.yaml')?.[1] as string;
			expect(pantryWritten).not.toContain('Chicken');

			// Freezer should have item added
			const freezerWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'freezer.yaml')?.[1] as string;
			expect(freezerWritten).toContain('Chicken');
		});

		it('dismisses alert on ok:<idx>', async () => {
			const store = mockStore({});
			const services = mockServices(store);

			await handlePerishableCallback(
				services as never, 'ok:0', 'user1', 123, 456, store as never,
			);

			expect(services.telegram.editMessage).toHaveBeenCalledWith(
				123, 456, expect.stringContaining('good'),
			);
		});

		it('removes from pantry and logs waste on toss:<idx>', async () => {
			const items = [makePantryItem({ name: 'Yogurt' })];
			const store = mockStore({ 'pantry.yaml': stringify({ items }) });
			const services = mockServices(store);

			await handlePerishableCallback(
				services as never, 'toss:0', 'user1', 123, 456, store as never,
			);

			// Waste log should have entry
			const wasteWritten = store.write.mock.calls.find((c: string[]) => c[0] === 'waste-log.yaml')?.[1] as string;
			expect(wasteWritten).toContain('Yogurt');
		});
	});

	describe('handlePerishableCheckJob', () => {
		it('alerts on pantry items expiring within 2 days', async () => {
			const items = [
				makePantryItem({ name: 'Chicken', expiryEstimate: '2026-04-03' }),
				makePantryItem({ name: 'Shelf Stable', category: 'Pantry & Dry Goods' }),
			];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'pantry.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handlePerishableCheckJob(services as never, '2026-04-02');

			expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
				'user1',
				expect.stringContaining('Chicken'),
				expect.any(Array),
			);
		});

		it('sends no alert when nothing is expiring', async () => {
			const items = [
				makePantryItem({ name: 'Fresh', expiryEstimate: '2026-04-20' }),
			];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'pantry.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handlePerishableCheckJob(services as never, '2026-04-02');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('skips items without expiryEstimate', async () => {
			const items = [
				makePantryItem({ name: 'NoExpiry', expiryEstimate: undefined }),
			];
			const householdData = stringify({ id: 'hh1', name: 'Test', createdBy: 'user1', members: ['user1'], joinCode: 'ABC', createdAt: '2026-01-01' });
			const store = mockStore({
				'pantry.yaml': stringify({ items }),
				'household.yaml': householdData,
			});
			const services = mockServices(store);

			await handlePerishableCheckJob(services as never, '2026-04-02');

			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/perishable-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement perishable-handler.ts**

Create `apps/hearthstone/src/handlers/perishable-handler.ts`:

```typescript
/**
 * Perishable handler — callbacks for pantry expiry alerts and daily check job.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { loadPantry, savePantry } from '../services/pantry-store.js';
import { addFreezerItem, loadFreezer, saveFreezer } from '../services/freezer-store.js';
import { appendWaste } from '../services/waste-store.js';
import type { FreezerItem, PantryItem, WasteLogEntry } from '../types.js';
import { todayDate } from '../utils/date.js';
import { loadHousehold } from '../utils/household-guard.js';

/**
 * Handle perishable alert callback actions.
 *
 * Actions: freeze:<idx>, ok:<idx>, toss:<idx>
 *
 * NOTE: <idx> refers to the index in the ORIGINAL pantry items array at the
 * time the alert was sent. Because alerts are sent from a filtered subset
 * (items with expiryEstimate within 2 days), the handler re-loads pantry and
 * uses the stored index. This is safe because the perishable-check job stores
 * the pantry index in the callback data, and pantry items are only removed by
 * explicit user action (not by background jobs).
 */
export async function handlePerishableCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
	store: ScopedDataStore,
): Promise<void> {
	if (action.startsWith('freeze:')) {
		const idx = Number.parseInt(action.slice(7), 10);
		if (Number.isNaN(idx)) return;
		const items = await loadPantry(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;

		// Remove from pantry
		const updatedPantry = [...items.slice(0, idx), ...items.slice(idx + 1)];
		await savePantry(store, updatedPantry);

		// Add to freezer
		const freezerItem: FreezerItem = {
			name: item.name,
			quantity: item.quantity,
			frozenDate: todayDate(services.timezone),
			source: 'pantry',
		};
		const freezerItems = await loadFreezer(store);
		await saveFreezer(store, addFreezerItem(freezerItems, freezerItem));

		await services.telegram.editMessage(chatId, messageId, `🧊 Moved to freezer: ${item.name}`);
		return;
	}

	if (action.startsWith('ok:')) {
		await services.telegram.editMessage(chatId, messageId, '👍 Still good — noted!');
		return;
	}

	if (action.startsWith('toss:')) {
		const idx = Number.parseInt(action.slice(5), 10);
		if (Number.isNaN(idx)) return;
		const items = await loadPantry(store);
		if (idx < 0 || idx >= items.length) return;
		const item = items[idx]!;

		// Remove from pantry
		const updatedPantry = [...items.slice(0, idx), ...items.slice(idx + 1)];
		await savePantry(store, updatedPantry);

		// Log waste
		const entry: WasteLogEntry = {
			name: item.name,
			quantity: item.quantity,
			reason: 'expired',
			source: 'pantry',
			date: todayDate(services.timezone),
		};
		await appendWaste(store, entry);

		await services.telegram.editMessage(chatId, messageId, `🗑 Tossed: ${item.name}`);
		return;
	}
}

/**
 * Daily 9am perishable check job.
 *
 * Checks pantry items with expiryEstimate within 2 days and sends
 * "freeze it or lose it" alerts to all household members.
 */
export async function handlePerishableCheckJob(
	services: CoreServices,
	todayOverride?: string,
): Promise<void> {
	const sharedStore = services.data.forShared('shared');

	const household = await loadHousehold(sharedStore);
	if (!household) return;

	const items = await loadPantry(sharedStore);
	if (!items.length) return;

	const today = todayOverride ?? todayDate(services.timezone);
	const todayMs = new Date(`${today}T00:00:00Z`).getTime();
	const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

	// Find items expiring within 2 days
	const expiring: Array<{ item: PantryItem; idx: number }> = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (!item.expiryEstimate) continue;
		const expiryMs = new Date(`${item.expiryEstimate}T00:00:00Z`).getTime();
		if (expiryMs <= todayMs + twoDaysMs) {
			expiring.push({ item, idx: i });
		}
	}

	if (!expiring.length) return;

	// Build message
	const lines: string[] = ['🥬 Perishable Alert!\n'];
	lines.push('Items approaching expiry in your pantry:\n');

	for (const { item } of expiring) {
		const expiryMs = new Date(`${item.expiryEstimate!}T00:00:00Z`).getTime();
		const daysLeft = Math.floor((expiryMs - todayMs) / (24 * 60 * 60 * 1000));
		const urgency = daysLeft <= 0 ? 'expires today' : daysLeft === 1 ? 'expires tomorrow' : `expires in ${daysLeft} days`;
		lines.push(`• ${item.name} — ${item.quantity} (${urgency})`);
	}

	// Build buttons
	const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
	for (const { item, idx } of expiring) {
		const name = item.name.length > 10 ? item.name.slice(0, 10) + '…' : item.name;
		const expiryMs = new Date(`${item.expiryEstimate!}T00:00:00Z`).getTime();
		const daysLeft = Math.floor((expiryMs - todayMs) / (24 * 60 * 60 * 1000));
		if (daysLeft <= 0) {
			buttons.push([
				{ text: `🧊 Freeze ${name}`, callbackData: `app:hearthstone:pa:freeze:${idx}` },
				{ text: `🗑 Toss`, callbackData: `app:hearthstone:pa:toss:${idx}` },
				{ text: `👍 Still good`, callbackData: `app:hearthstone:pa:ok:${idx}` },
			]);
		} else {
			buttons.push([
				{ text: `🧊 Move to Freezer`, callbackData: `app:hearthstone:pa:freeze:${idx}` },
				{ text: `👍 Still good`, callbackData: `app:hearthstone:pa:ok:${idx}` },
			]);
		}
	}

	const message = lines.join('\n').trimEnd();
	for (const memberId of household.members) {
		await services.telegram.sendWithButtons(memberId, message, buttons);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/handlers/perishable-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/handlers/perishable-handler.ts apps/hearthstone/src/__tests__/handlers/perishable-handler.test.ts
git commit -m "feat(hearthstone): add perishable handler with pantry expiry alerts"
```

---

## Task 8: Integrate into index.ts — Commands, Callbacks, Intents, Jobs

**Files:**
- Modify: `apps/hearthstone/src/index.ts`

This is the largest integration task. It touches imports, commands, callback routing, intent detection, scheduled job dispatch, and pending state maps.

- [ ] **Step 1: Add imports at top of index.ts**

After the existing handler imports (around line 66), add:

```typescript
import { handleLeftoverCallback, handleLeftoverCheckJob } from './handlers/leftover-handler.js';
import { handleFreezerCallback, handleFreezerCheckJob } from './handlers/freezer-handler.js';
import { handlePerishableCallback, handlePerishableCheckJob } from './handlers/perishable-handler.js';
import {
	addLeftover,
	buildLeftoverButtons,
	formatLeftoverList,
	loadLeftovers,
	parseLeftoverInput,
	saveLeftovers,
} from './services/leftover-store.js';
import {
	addFreezerItem,
	buildFreezerButtons,
	formatFreezerList,
	loadFreezer,
	parseFreezerInput,
	saveFreezer,
} from './services/freezer-store.js';
import { appendWaste } from './services/waste-store.js';
import type { WasteLogEntry } from './types.js';
```

Note: `GroceryItem` and `Recipe` are already imported from `./types.js` on line 68. Add `WasteLogEntry` to that existing import.

- [ ] **Step 2: Add pending state maps after the existing pendingPantryItems block (around line 675)**

```typescript
// ─── H6: Pending leftover/freezer add state ────────────────────
const pendingLeftoverAdd = new Map<string, { fromRecipe?: string; expiresAt: number }>();
const pendingFreezerAdd = new Map<string, { expiresAt: number }>();

function setPendingLeftoverAdd(userId: string, fromRecipe?: string): void {
	pendingLeftoverAdd.set(userId, { fromRecipe, expiresAt: Date.now() + PENDING_TTL_MS });
	if (pendingLeftoverAdd.size > 100) {
		const oldest = pendingLeftoverAdd.keys().next().value;
		if (oldest) pendingLeftoverAdd.delete(oldest);
	}
}

function consumePendingLeftoverAdd(userId: string): { fromRecipe?: string } | undefined {
	const entry = pendingLeftoverAdd.get(userId);
	pendingLeftoverAdd.delete(userId);
	if (!entry || Date.now() > entry.expiresAt) return undefined;
	return { fromRecipe: entry.fromRecipe };
}

export function hasPendingLeftoverAdd(userId: string): boolean {
	const entry = pendingLeftoverAdd.get(userId);
	if (!entry) return false;
	if (Date.now() > entry.expiresAt) {
		pendingLeftoverAdd.delete(userId);
		return false;
	}
	return true;
}

function setPendingFreezerAdd(userId: string): void {
	pendingFreezerAdd.set(userId, { expiresAt: Date.now() + PENDING_TTL_MS });
	if (pendingFreezerAdd.size > 100) {
		const oldest = pendingFreezerAdd.keys().next().value;
		if (oldest) pendingFreezerAdd.delete(oldest);
	}
}

function consumePendingFreezerAdd(userId: string): boolean {
	const entry = pendingFreezerAdd.get(userId);
	pendingFreezerAdd.delete(userId);
	if (!entry || Date.now() > entry.expiresAt) return false;
	return true;
}

function hasPendingFreezerAdd(userId: string): boolean {
	const entry = pendingFreezerAdd.get(userId);
	if (!entry) return false;
	if (Date.now() > entry.expiresAt) {
		pendingFreezerAdd.delete(userId);
		return false;
	}
	return true;
}
```

- [ ] **Step 3: Add pending state checks in handleMessage (after the cook mode checks, before intent detection, around line 113)**

After `if (hasPendingCookRecipe(ctx.userId)) { ... }` block, add:

```typescript
	// H6: Pending leftover add — next text message after "Yes, log leftovers"
	if (hasPendingLeftoverAdd(ctx.userId)) {
		await handlePendingLeftoverAdd(text, ctx);
		return;
	}

	// H6: Pending freezer add — next text message after "Add to freezer" button
	if (hasPendingFreezerAdd(ctx.userId)) {
		await handlePendingFreezerAdd(text, ctx);
		return;
	}
```

- [ ] **Step 4: Add H6 intent checks in handleMessage (before isFoodQuestionIntent, around line 160)**

Before `if (isFoodQuestionIntent(lower)) {` add:

```typescript
	// H6: Leftover intents
	if (isLeftoverAddIntent(lower)) {
		await handleLeftoverAddIntent(text, ctx);
		return;
	}

	if (isLeftoverViewIntent(lower)) {
		await handleLeftoversView(ctx);
		return;
	}

	// H6: Freezer intents
	if (isFreezerAddIntent(lower)) {
		await handleFreezerAddIntent(text, ctx);
		return;
	}

	if (isFreezerViewIntent(lower)) {
		await handleFreezerView(ctx);
		return;
	}

	// H6: Waste intent
	if (isWasteIntent(lower)) {
		await handleWasteIntent(text, ctx);
		return;
	}
```

- [ ] **Step 5: Add commands in handleCommand switch (before default case, around line 275)**

```typescript
		case 'leftovers':
			await handleLeftoversCommand(args, ctx);
			break;
		case 'freezer':
			await handleFreezerCommand(args, ctx);
			break;
```

- [ ] **Step 6: Add callback routing in handleCallbackQuery (after the cook mode block, before the catch, around line 650)**

```typescript
		// ─── H6: Leftover callbacks ─────────────────────────
		if (data.startsWith('lo:')) {
			if (data === 'lo:add') {
				setPendingLeftoverAdd(ctx.userId);
				await services.telegram.editMessage(ctx.chatId, ctx.messageId, 'What leftovers do you have? (e.g., "chili, about 3 servings")');
				return;
			}
			if (data === 'lo:post-meal:yes') {
				// Get recipe name from the message context — set pending for next text
				setPendingLeftoverAdd(ctx.userId); // fromRecipe will be extracted from context
				await services.telegram.editMessage(ctx.chatId, ctx.messageId, 'What leftovers do you have? (e.g., "about 3 servings of chili")');
				return;
			}
			await handleLeftoverCallback(services, data.slice(3), ctx.userId, ctx.chatId, ctx.messageId, hh.sharedStore);
			return;
		}

		// ─── H6: Freezer callbacks ──────────────────────────
		if (data.startsWith('fz:')) {
			if (data === 'fz:add') {
				setPendingFreezerAdd(ctx.userId);
				await services.telegram.editMessage(ctx.chatId, ctx.messageId, 'What would you like to add to the freezer? (e.g., "2 lbs chicken breasts")');
				return;
			}
			await handleFreezerCallback(services, data.slice(3), ctx.userId, ctx.chatId, ctx.messageId, hh.sharedStore);
			return;
		}

		// ─── H6: Perishable alert callbacks ─────────────────
		if (data.startsWith('pa:')) {
			await handlePerishableCallback(services, data.slice(3), ctx.userId, ctx.chatId, ctx.messageId, hh.sharedStore);
			return;
		}
```

- [ ] **Step 7: Add scheduled job dispatch in handleScheduledJob (after the nightly-rating-prompt block, around line 1653)**

```typescript
	// H6: Perishable check daily 9am
	if (jobId === 'perishable-check') {
		await handlePerishableCheckJob(services);
		return;
	}

	// H6: Leftover check daily 10am
	if (jobId === 'leftover-check') {
		await handleLeftoverCheckJob(services);
		return;
	}

	// H6: Freezer check Mondays 9am
	if (jobId === 'freezer-check') {
		await handleFreezerCheckJob(services);
		return;
	}
```

- [ ] **Step 8: Add intent detection functions (at the end of the file, before the existing intent functions section)**

```typescript
// ─── H6: Intent Detection ──────────────────────────────────────

function isLeftoverAddIntent(lower: string): boolean {
	return (
		/\b(leftover|left over)\b/i.test(lower) && /\b(have|got|save|store|put|log)\b/i.test(lower)
	) || /\b(there'?s|we'?ve got)\b.*\b(left over|leftover|remaining)\b/i.test(lower);
}

function isLeftoverViewIntent(lower: string): boolean {
	return (
		/\b(show|view|see|check|list|what)\b.*\bleftovers?\b/i.test(lower) ||
		/\bany\s+leftovers?\b/i.test(lower) ||
		/\bwhat'?s\s+left\s+over\b/i.test(lower)
	);
}

function isFreezerAddIntent(lower: string): boolean {
	return (
		/\b(add|put|store|move)\b.*\b(to|in)\s+(the\s+)?freezer\b/i.test(lower) ||
		/\bfreeze\s+(the|some|this|my|our)\b/i.test(lower)
	);
}

function isFreezerViewIntent(lower: string): boolean {
	return (
		/\b(show|view|see|check|list)\b.*\bfreezer\b/i.test(lower) ||
		/\bwhat'?s\s+in\s+(the\s+)?freezer\b/i.test(lower)
	);
}

function isWasteIntent(lower: string): boolean {
	return (
		/\b(throw|threw|toss|tossed|discard|dump)\b.*\b(out|away)\b/i.test(lower) ||
		/\b(went bad|gone bad|spoiled|expired|moldy|rotten)\b/i.test(lower)
	);
}
```

- [ ] **Step 9: Add intent handler functions**

```typescript
// ─── H6: Leftover Intent Handlers ──────────────────────────────

async function handleLeftoversView(ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}
	const items = await loadLeftovers(hh.sharedStore);
	const active = items.filter((l) => l.status === 'active');
	if (!active.length) {
		await services.telegram.send(ctx.userId, '🥘 You have no leftovers tracked.');
		return;
	}
	await services.telegram.sendWithButtons(
		ctx.userId,
		formatLeftoverList(items, todayDate(services.timezone)),
		buildLeftoverButtons(items),
	);
}

async function handleLeftoverAddIntent(text: string, ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	// Extract leftover description from NL text
	const itemText = text
		.replace(/^(we\s+)?have\s+(some\s+)?/i, '')
		.replace(/\b(leftover|left over|remaining)\b/gi, '')
		.replace(/\b(from\s+(last\s+)?night|from\s+tonight|from\s+dinner|from\s+lunch)\b/gi, '')
		.trim();

	if (!itemText) {
		setPendingLeftoverAdd(ctx.userId);
		await services.telegram.send(ctx.userId, 'What leftovers do you have? (e.g., "chili, about 3 servings")');
		return;
	}

	const parsed = parseLeftoverInput(itemText, undefined, services.timezone);

	// Estimate expiry via LLM
	let expiryEstimate: string;
	try {
		const daysStr = await services.llm.complete(
			`How many days does ${sanitizeInput(parsed.name)} last in the fridge? Reply with just a number.`,
			{ tier: 'fast' },
		);
		const days = Number.parseInt(daysStr.trim(), 10);
		const expiry = new Date(`${parsed.storedDate}T00:00:00Z`);
		expiry.setUTCDate(expiry.getUTCDate() + (Number.isNaN(days) ? 3 : days));
		expiryEstimate = expiry.toISOString().slice(0, 10);
	} catch {
		// Default to 3 days
		const expiry = new Date(`${parsed.storedDate}T00:00:00Z`);
		expiry.setUTCDate(expiry.getUTCDate() + 3);
		expiryEstimate = expiry.toISOString().slice(0, 10);
	}

	const leftover: Leftover = { ...parsed, expiryEstimate };
	const existing = await loadLeftovers(hh.sharedStore);
	const updated = addLeftover(existing, leftover);
	await saveLeftovers(hh.sharedStore, updated);

	await services.telegram.send(
		ctx.userId,
		`🥘 Logged: ${leftover.name} — ${leftover.quantity} (use by ${expiryEstimate})`,
	);
	services.logger.info('Logged leftover "%s" for %s', leftover.name, ctx.userId);
}

async function handlePendingLeftoverAdd(text: string, ctx: MessageContext): Promise<void> {
	const pending = consumePendingLeftoverAdd(ctx.userId);
	if (!pending) return;

	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) return;

	const parsed = parseLeftoverInput(text, pending.fromRecipe, services.timezone);

	// Estimate expiry via LLM
	let expiryEstimate: string;
	try {
		const daysStr = await services.llm.complete(
			`How many days does ${sanitizeInput(parsed.name)} last in the fridge? Reply with just a number.`,
			{ tier: 'fast' },
		);
		const days = Number.parseInt(daysStr.trim(), 10);
		const expiry = new Date(`${parsed.storedDate}T00:00:00Z`);
		expiry.setUTCDate(expiry.getUTCDate() + (Number.isNaN(days) ? 3 : days));
		expiryEstimate = expiry.toISOString().slice(0, 10);
	} catch {
		const expiry = new Date(`${parsed.storedDate}T00:00:00Z`);
		expiry.setUTCDate(expiry.getUTCDate() + 3);
		expiryEstimate = expiry.toISOString().slice(0, 10);
	}

	const leftover: Leftover = { ...parsed, expiryEstimate };
	const existing = await loadLeftovers(hh.sharedStore);
	const updated = addLeftover(existing, leftover);
	await saveLeftovers(hh.sharedStore, updated);

	await services.telegram.send(
		ctx.userId,
		`🥘 Logged: ${leftover.name} — ${leftover.quantity} (use by ${expiryEstimate})`,
	);
}

// ─── H6: Freezer Intent Handlers ───────────────────────────────

async function handleFreezerView(ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}
	const items = await loadFreezer(hh.sharedStore);
	if (!items.length) {
		await services.telegram.send(ctx.userId, '🧊 Your freezer is empty.');
		return;
	}
	await services.telegram.sendWithButtons(
		ctx.userId,
		formatFreezerList(items, todayDate(services.timezone)),
		buildFreezerButtons(items),
	);
}

async function handleFreezerAddIntent(text: string, ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	const itemText = text
		.replace(/^(add|put|store|move)\s+/i, '')
		.replace(/\s*(to|in)\s+(the\s+)?freezer/i, '')
		.replace(/^(some|the|a|an)\s+/i, '')
		.replace(/\bfreeze\s+(the|some|this|my|our)\s+/i, '')
		.trim();

	if (!itemText) {
		setPendingFreezerAdd(ctx.userId);
		await services.telegram.send(ctx.userId, 'What would you like to add to the freezer? (e.g., "2 lbs chicken breasts")');
		return;
	}

	const item = parseFreezerInput(itemText, 'manual', services.timezone);
	const existing = await loadFreezer(hh.sharedStore);
	const updated = addFreezerItem(existing, item);
	await saveFreezer(hh.sharedStore, updated);

	await services.telegram.send(ctx.userId, `🧊 Added to freezer: ${item.name} — ${item.quantity}`);
	services.logger.info('Added freezer item "%s" for %s', item.name, ctx.userId);
}

async function handlePendingFreezerAdd(text: string, ctx: MessageContext): Promise<void> {
	if (!consumePendingFreezerAdd(ctx.userId)) return;

	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) return;

	const item = parseFreezerInput(text, 'manual', services.timezone);
	const existing = await loadFreezer(hh.sharedStore);
	const updated = addFreezerItem(existing, item);
	await saveFreezer(hh.sharedStore, updated);

	await services.telegram.send(ctx.userId, `🧊 Added to freezer: ${item.name} — ${item.quantity}`);
}

// ─── H6: Waste Intent Handler ──────────────────────────────────

async function handleWasteIntent(text: string, ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	const itemText = text
		.replace(/\b(throw|threw|toss|tossed|discard|dump)(ed)?\b/gi, '')
		.replace(/\b(out|away)\b/gi, '')
		.replace(/\b(the|some|it|went bad|gone bad|spoiled|expired|moldy|rotten)\b/gi, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!itemText) {
		await services.telegram.send(ctx.userId, 'What went bad? (e.g., "the milk spoiled")');
		return;
	}

	const reason: WasteLogEntry['reason'] = /\b(spoil|mold|rotten)\b/i.test(text) ? 'spoiled' : 'expired';

	const entry: WasteLogEntry = {
		name: itemText,
		quantity: 'some',
		reason,
		source: 'pantry',
		date: todayDate(services.timezone),
	};
	await appendWaste(hh.sharedStore, entry);

	// Try to remove from pantry if it exists
	const pantry = await loadPantry(hh.sharedStore);
	const pantryIdx = pantry.findIndex((p) => p.name.toLowerCase() === itemText.toLowerCase());
	if (pantryIdx >= 0) {
		const updated = [...pantry.slice(0, pantryIdx), ...pantry.slice(pantryIdx + 1)];
		await savePantry(hh.sharedStore, updated);
	}

	await services.telegram.send(ctx.userId, `🗑 Logged waste: ${itemText}. Sorry about that!`);
	services.logger.info('Logged food waste "%s" for %s', itemText, ctx.userId);
}

// ─── H6: Leftover/Freezer Commands ─────────────────────────────

async function handleLeftoversCommand(args: string[], ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	const text = args.join(' ').trim();
	if (text) {
		// Direct add: /leftovers chili, 3 servings
		await handleLeftoverAddIntent(text, ctx);
		return;
	}

	// View mode
	await handleLeftoversView(ctx);
}

async function handleFreezerCommand(args: string[], ctx: MessageContext): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(ctx.userId, 'Set up a household first with /household create <name>');
		return;
	}

	const text = args.join(' ').trim();
	if (text) {
		// Direct add: /freezer 2 lbs chicken breasts
		await handleFreezerAddIntent(text, ctx);
		return;
	}

	// View mode
	await handleFreezerView(ctx);
}
```

Note: The `Leftover` type import will need to be added to the existing type imports line. The `sanitizeInput` import is already present.

- [ ] **Step 10: Update the fallback help message to include leftover/freezer commands**

In the fallback message (around line 221), add after the cook mode line:

```typescript
			'• "we have leftover chili" — log leftovers\n' +
			'• /leftovers — view and manage leftovers\n' +
			'• /freezer — view and manage freezer\n' +
```

- [ ] **Step 11: Verify it compiles**

Run: `cd apps/hearthstone && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 12: Run all existing tests to ensure no regressions**

Run: `cd apps/hearthstone && npx vitest run`
Expected: All tests PASS

- [ ] **Step 13: Commit**

```bash
git add apps/hearthstone/src/index.ts
git commit -m "feat(hearthstone): integrate H6 — commands, callbacks, intents, scheduled jobs"
```

---

## Task 9: Post-Rating and Post-Cook Leftover Prompts

**Files:**
- Modify: `apps/hearthstone/src/handlers/rating.ts:146`
- Modify: `apps/hearthstone/src/handlers/cook-mode.ts:383`

- [ ] **Step 1: Add leftover prompt to handleRateCallback in rating.ts**

After the final `editMessage` call in `handleRateCallback` (line 146), add a follow-up message:

```typescript
	// H6: Ask about leftovers after rating
	if (direction !== 'skip' && meal.recipeTitle) {
		await services.telegram.sendWithButtons(
			userId,
			`Any leftovers from ${meal.recipeTitle}?`,
			[[
				{ text: 'Yes, log leftovers', callbackData: 'app:hearthstone:lo:post-meal:yes' },
				{ text: 'No leftovers', callbackData: 'app:hearthstone:lo:post-meal:no' },
			]],
		);
	}
```

This goes right before the closing `}` of `handleRateCallback`.

- [ ] **Step 2: Add leftover prompt to cook-mode done callback**

In `handleCookCallback` in cook-mode.ts, in the `case 'd':` block (around line 377-386), after `endSession(userId)`, add:

```typescript
				// H6: Ask about leftovers
				await services.telegram.sendWithButtons(
					userId,
					`Any leftovers from ${session.recipeTitle}?`,
					[[
						{ text: 'Yes, log leftovers', callbackData: 'app:hearthstone:lo:post-meal:yes' },
						{ text: 'No leftovers', callbackData: 'app:hearthstone:lo:post-meal:no' },
					]],
				);
```

Also add the same in the `handleCookTextAction` done case (around line 517-525), after `endSession(ctx.userId)`:

```typescript
				// H6: Ask about leftovers
				await services.telegram.sendWithButtons(
					ctx.userId,
					`Any leftovers from ${session.recipeTitle}?`,
					[[
						{ text: 'Yes, log leftovers', callbackData: 'app:hearthstone:lo:post-meal:yes' },
						{ text: 'No leftovers', callbackData: 'app:hearthstone:lo:post-meal:no' },
					]],
				);
```

Note: Save `session.recipeTitle` before calling `endSession()` since it destroys the session.

- [ ] **Step 3: Run tests to verify no regressions**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/rating-handler.test.ts src/__tests__/cook-mode-handler.test.ts`
Expected: PASS (existing tests may need minor updates for the new `sendWithButtons` call)

- [ ] **Step 4: Commit**

```bash
git add apps/hearthstone/src/handlers/rating.ts apps/hearthstone/src/handlers/cook-mode.ts
git commit -m "feat(hearthstone): add post-rating and post-cook leftover prompts"
```

---

## Task 10: Pantry Expiry Estimation for Perishables

**Files:**
- Modify: `apps/hearthstone/src/services/pantry-store.ts`
- Modify: `apps/hearthstone/src/index.ts` (the `pantry-all` callback)

- [ ] **Step 1: Add expiry estimation function to pantry-store.ts**

Add at the end of `pantry-store.ts`:

```typescript
/** Perishable categories that should get LLM-estimated expiry. */
const PERISHABLE_CATEGORIES = new Set([
	'Produce',
	'Dairy & Eggs',
	'Meat & Seafood',
	'Bakery',
]);

/** Check if a pantry item's category is perishable. */
export function isPerishableCategory(category: string): boolean {
	return PERISHABLE_CATEGORIES.has(category);
}

/**
 * Enrich perishable pantry items with LLM-estimated expiry dates.
 * Only estimates for items that don't already have an expiryEstimate
 * and are in perishable categories.
 */
export async function enrichWithExpiry(
	services: { llm: { complete: (prompt: string, opts: { tier: string }) => Promise<string> }; timezone: string },
	items: PantryItem[],
): Promise<PantryItem[]> {
	const result = [...items];
	for (let i = 0; i < result.length; i++) {
		const item = result[i]!;
		if (item.expiryEstimate || !isPerishableCategory(item.category)) continue;

		try {
			const daysStr = await services.llm.complete(
				`How many days does ${item.name} last in the fridge after purchase? Reply with just a number.`,
				{ tier: 'fast' },
			);
			const days = Number.parseInt(daysStr.trim(), 10);
			if (!Number.isNaN(days) && days > 0) {
				const expiry = new Date(`${item.addedDate}T00:00:00Z`);
				expiry.setUTCDate(expiry.getUTCDate() + days);
				result[i] = { ...item, expiryEstimate: expiry.toISOString().slice(0, 10) };
			}
		} catch {
			// Skip estimation on failure — item remains without expiryEstimate
		}
	}
	return result;
}
```

- [ ] **Step 2: Call enrichWithExpiry in the pantry-all callback in index.ts**

In the `pantry-all` callback handler (around line 367-387), after converting grocery items to pantry items and before saving, add expiry estimation:

Change:
```typescript
const pantryItems = groceryToPantryItems(purchased, services.timezone);
const existing = await loadPantry(hh.sharedStore);
const updated = addPantryItems(existing, pantryItems);
await savePantry(hh.sharedStore, updated);
```

To:
```typescript
import { enrichWithExpiry } from './services/pantry-store.js';
// (enrichWithExpiry is already exported — add it to the existing import at top of file)

let pantryItems = groceryToPantryItems(purchased, services.timezone);
// H6: Estimate expiry for perishable items
pantryItems = await enrichWithExpiry(services, pantryItems);
const existing = await loadPantry(hh.sharedStore);
const updated = addPantryItems(existing, pantryItems);
await savePantry(hh.sharedStore, updated);
```

Add `enrichWithExpiry` to the existing pantry-store import at the top of index.ts.

- [ ] **Step 3: Add test for enrichWithExpiry**

Add to `apps/hearthstone/src/__tests__/services/leftover-store.test.ts` (or create a new section in pantry-store.test.ts):

In `apps/hearthstone/src/__tests__/pantry-store.test.ts`, add:

```typescript
import { enrichWithExpiry, isPerishableCategory } from '../services/pantry-store.js';

describe('expiry estimation', () => {
	it('isPerishableCategory returns true for perishable categories', () => {
		expect(isPerishableCategory('Produce')).toBe(true);
		expect(isPerishableCategory('Dairy & Eggs')).toBe(true);
		expect(isPerishableCategory('Meat & Seafood')).toBe(true);
		expect(isPerishableCategory('Bakery')).toBe(true);
	});

	it('isPerishableCategory returns false for shelf-stable categories', () => {
		expect(isPerishableCategory('Pantry & Dry Goods')).toBe(false);
		expect(isPerishableCategory('Beverages')).toBe(false);
		expect(isPerishableCategory('Snacks')).toBe(false);
	});

	it('enrichWithExpiry adds expiryEstimate to perishable items', async () => {
		const items = [
			makePantryItem({ name: 'Chicken', category: 'Meat & Seafood', addedDate: '2026-04-01' }),
			makePantryItem({ name: 'Rice', category: 'Pantry & Dry Goods' }),
		];
		const services = {
			llm: { complete: vi.fn().mockResolvedValue('3') },
			timezone: 'UTC',
		};

		const result = await enrichWithExpiry(services, items);
		expect(result[0]?.expiryEstimate).toBe('2026-04-04');
		expect(result[1]?.expiryEstimate).toBeUndefined();
	});

	it('enrichWithExpiry skips items that already have expiryEstimate', async () => {
		const items = [
			makePantryItem({ name: 'Milk', category: 'Dairy & Eggs', expiryEstimate: '2026-04-05' }),
		];
		const services = {
			llm: { complete: vi.fn() },
			timezone: 'UTC',
		};

		const result = await enrichWithExpiry(services, items);
		expect(result[0]?.expiryEstimate).toBe('2026-04-05');
		expect(services.llm.complete).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/pantry-store.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hearthstone/src/services/pantry-store.ts apps/hearthstone/src/__tests__/pantry-store.test.ts apps/hearthstone/src/index.ts
git commit -m "feat(hearthstone): add perishable expiry estimation for pantry items"
```

---

## Task 11: Natural Language Tests

**Files:**
- Modify: `apps/hearthstone/src/__tests__/natural-language.test.ts`

- [ ] **Step 1: Add H6 intent tests**

Add a new `describe('H6: Leftover/Freezer/Waste intents')` block to the existing natural-language test file. Test the intent detection functions by importing them (they need to be exported from index.ts or extracted). If they're private functions, test via the `handleMessage` integration path instead.

Create intent-level tests:

```typescript
describe('H6: leftover, freezer, and waste intents', () => {
	it('routes "we have leftover chili" to leftover add', async () => {
		// Send message through handleMessage and verify LLM was called for expiry
		// and telegram.send was called with confirmation
	});

	it('routes "any leftovers?" to leftover view', async () => {
		// Verify formatLeftoverList output is sent
	});

	it('routes "add chicken to freezer" to freezer add', async () => {
		// Verify freezer item is saved
	});

	it('routes "what\'s in the freezer?" to freezer view', async () => {
		// Verify formatFreezerList output is sent
	});

	it('routes "the milk went bad" to waste logging', async () => {
		// Verify waste log entry is appended
	});

	it('routes "threw out the old rice" to waste logging', async () => {
		// Verify waste log entry
	});
});
```

The exact test implementation depends on the test patterns already in `natural-language.test.ts`. Follow that file's existing mock setup and assertion patterns.

- [ ] **Step 2: Run natural language tests**

Run: `cd apps/hearthstone && npx vitest run src/__tests__/natural-language.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add apps/hearthstone/src/__tests__/natural-language.test.ts
git commit -m "test(hearthstone): add H6 natural language intent tests"
```

---

## Task 12: Full Test Suite + Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the full Hearthstone test suite**

Run: `cd apps/hearthstone && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compilation check**

Run: `cd apps/hearthstone && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run the full project build**

Run: `pnpm build`
Expected: No errors

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No errors (or only pre-existing warnings)

- [ ] **Step 5: Run the full project test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 6: Update docs/implementation-phases.md with H6 completion status**

Add H6 entry after H5b in the implementation phases doc.

- [ ] **Step 7: Final commit**

```bash
git add docs/implementation-phases.md
git commit -m "docs: mark Hearthstone H6 complete — leftovers, freezer, waste, perishable alerts"
```

---

## Verification

1. **Unit tests**: Each store (leftover, freezer, waste) has tests for load/save/add/remove/format
2. **Handler tests**: Each handler has tests for callback actions and scheduled jobs
3. **Integration**: Natural language intent routing tested for all H6 phrases
4. **Build**: TypeScript compiles, lint passes, all project tests pass
5. **Manual testing** (after deployment):
   - `/leftovers` — view, add, use/freeze/toss actions
   - `/freezer` — view, add, thaw/toss actions
   - Rate a meal → leftover prompt appears
   - Cook mode done → leftover prompt appears
   - Add groceries to pantry → perishable items get expiry estimates
   - Wait for 9am → perishable alert with freeze/toss buttons
   - Wait for 10am → leftover expiry alert with freeze/eat/toss buttons
   - Wait for Monday 9am → freezer aging reminder
