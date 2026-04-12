# F9: Telegram Markdown Escaping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix inconsistent Telegram Markdown escaping (Finding 9) by creating a shared `escapeMarkdown` utility, applying it in food app formatters, echo/notes apps, reports, and alerts, and replacing the over-escaping MarkdownV2 implementations in the router/verifier.

**Architecture:** A single `escapeMarkdown` utility in core escapes legacy Markdown control characters (`*`, `_`, `` ` ``, `[`, `]`, `(`, `)`). It is exported via `@pas/core/utils/escape-markdown` for app consumption. Escaping is applied at interpolation points in formatters (food app) and at the Telegram delivery boundary (reports, alerts). LLM output is not escaped (trusted formatter). The router/verifier switch from MarkdownV2 escaping to the shared legacy Markdown utility.

**Tech Stack:** TypeScript, Vitest, existing `TelegramService` with `parse_mode: 'Markdown'` (legacy)

---

### Task 1: Create shared `escapeMarkdown` utility in core

**Files:**
- Create: `core/src/utils/escape-markdown.ts`
- Create: `core/src/utils/__tests__/escape-markdown.test.ts`
- Modify: `core/package.json:9-42`

- [ ] **Step 1: Write the tests**

Create `core/src/utils/__tests__/escape-markdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeMarkdown } from '../escape-markdown.js';

describe('escapeMarkdown', () => {
	it('escapes asterisks', () => {
		expect(escapeMarkdown('hello *world*')).toBe('hello \\*world\\*');
	});

	it('escapes underscores', () => {
		expect(escapeMarkdown('hello _world_')).toBe('hello \\_world\\_');
	});

	it('escapes backticks', () => {
		expect(escapeMarkdown('hello `world`')).toBe('hello \\`world\\`');
	});

	it('escapes square brackets', () => {
		expect(escapeMarkdown('hello [world]')).toBe('hello \\[world\\]');
	});

	it('escapes parentheses', () => {
		expect(escapeMarkdown('hello (world)')).toBe('hello \\(world\\)');
	});

	it('escapes multiple special characters in one string', () => {
		expect(escapeMarkdown('*bold* and _italic_ and `code`')).toBe(
			'\\*bold\\* and \\_italic\\_ and \\`code\\`',
		);
	});

	it('passes safe strings through unchanged', () => {
		expect(escapeMarkdown('hello world 123')).toBe('hello world 123');
	});

	it('handles empty string', () => {
		expect(escapeMarkdown('')).toBe('');
	});

	it('does not escape MarkdownV2-only characters', () => {
		expect(escapeMarkdown('hello.world! test-case #1 ~strikethrough~')).toBe(
			'hello.world! test-case #1 ~strikethrough~',
		);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run src/utils/__tests__/escape-markdown.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `core/src/utils/escape-markdown.ts`:

```ts
/**
 * Escape Telegram legacy Markdown control characters in user/stored data.
 *
 * TelegramService uses parse_mode: 'Markdown' (legacy), where *, _, `, and [
 * are control characters. This function escapes them so interpolated data
 * renders as literal text rather than triggering formatting or causing
 * "can't parse entities" API errors.
 */
const SPECIALS = /[*_`[\]()]/g;

export function escapeMarkdown(text: string): string {
	return text.replace(SPECIALS, (m) => '\\' + m);
}
```

- [ ] **Step 4: Add package.json export**

In `core/package.json`, add after the `"./utils/cron-describe"` export:

```json
"./utils/escape-markdown": {
	"import": "./dist/utils/escape-markdown.js",
	"types": "./dist/utils/escape-markdown.d.ts"
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd core && npx vitest run src/utils/__tests__/escape-markdown.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add core/src/utils/escape-markdown.ts core/src/utils/__tests__/escape-markdown.test.ts core/package.json
git commit -m "feat: add shared escapeMarkdown utility for Telegram legacy Markdown (F9)"
```

---

### Task 2: Migrate food app to re-export from core

**Files:**
- Modify: `apps/food/src/utils/escape-markdown.ts`

- [ ] **Step 1: Replace the local implementation with a re-export**

Replace the entire contents of `apps/food/src/utils/escape-markdown.ts` with:

```ts
/**
 * Re-export the shared escapeMarkdown utility from core.
 * All food app imports continue to work unchanged.
 */
export { escapeMarkdown } from '@pas/core/utils/escape-markdown';
```

- [ ] **Step 2: Run existing food app tests to verify no regressions**

Run: `cd apps/food && npx vitest run`
Expected: All existing tests pass — the function signature and behavior are identical.

- [ ] **Step 3: Commit**

```bash
git add apps/food/src/utils/escape-markdown.ts
git commit -m "refactor: food app re-exports escapeMarkdown from core (F9)"
```

---

### Task 3: Escape data in `formatRecipe()` and `formatSearchResults()`

**Files:**
- Modify: `apps/food/src/services/recipe-store.ts:214-288`
- Modify: `apps/food/src/__tests__/recipe-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/food/src/__tests__/recipe-store.test.ts`, inside the `describe('formatRecipe')` block:

```ts
it('escapes Markdown control characters in dynamic fields', () => {
	const recipe = makeRecipe({
		title: "Mom's *Best* Recipe",
		cuisine: 'Thai_fusion',
		tags: ['kid_friendly', 'quick*easy'],
		ingredients: [
			{
				name: 'sugar [brown]',
				quantity: 1,
				unit: 'cup',
				notes: 'use `raw` if possible',
			},
		],
		instructions: ['Stir *vigorously* for _5 min_'],
	});

	const text = formatRecipe(recipe);

	// Data fields should be escaped
	expect(text).toContain("\\*Best\\*");
	expect(text).toContain('Thai\\_fusion');
	expect(text).toContain('kid\\_friendly');
	expect(text).toContain('quick\\*easy');
	expect(text).toContain('sugar \\[brown\\]');
	expect(text).toContain('use \\`raw\\` if possible');
	expect(text).toContain('Stir \\*vigorously\\*');
	expect(text).toContain('\\_5 min\\_');
	// Intentional formatting markers should still be present
	// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
	// mismatch deferred to Finding 21. Only assert data-field escaping here.
});
```

Add inside the `describe('formatSearchResults')` block:

```ts
it('escapes Markdown control characters in search result titles', () => {
	const results: RecipeSearchResult[] = [
		{
			recipe: makeRecipe({ title: "Mom's *Best* Recipe" }),
			relevance: 'exact_match',
		},
	];

	const text = formatSearchResults(results);

	expect(text).toContain("\\*Best\\*");
	// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
	// mismatch deferred to Finding 21. Only assert data-field escaping here.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/food && npx vitest run src/__tests__/recipe-store.test.ts`
Expected: FAIL — unescaped `*Best*` in output

- [ ] **Step 3: Add escapeMarkdown to `formatRecipe()` and `formatSearchResults()`**

In `apps/food/src/services/recipe-store.ts`, add import at the top:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatRecipe()` (line 214), escape all dynamic data fields. Replace lines 216-267 with:

```ts
	const lines: string[] = [];
	const status = recipe.status === 'draft' ? ' (draft)' : '';
	lines.push(`**${escapeMarkdown(recipe.title)}**${status}`);

	if (recipe.cuisine) lines.push(`Cuisine: ${escapeMarkdown(recipe.cuisine)}`);

	const time: string[] = [];
	if (recipe.prepTime) time.push(`prep ${recipe.prepTime}min`);
	if (recipe.cookTime) time.push(`cook ${recipe.cookTime}min`);
	if (time.length) lines.push(`Time: ${time.join(', ')}`);

	lines.push(`Servings: ${recipe.servings}`);

	if (recipe.tags.length) lines.push(`Tags: ${recipe.tags.map(escapeMarkdown).join(', ')}`);

	if (recipe.ratings.length) {
		const avg = recipe.ratings.reduce((s, r) => s + r.score, 0) / recipe.ratings.length;
		lines.push(`Rating: ${avg.toFixed(1)}/5 (${recipe.ratings.length} ratings)`);
	}

	if (brief) return lines.join('\n');

	// Full format
	lines.push('');
	lines.push('**Ingredients:**');
	for (const ing of recipe.ingredients) {
		const qty = ing.quantity != null ? `${ing.quantity}` : '';
		const unit = ing.unit ? escapeMarkdown(ing.unit) : '';
		const prefix = [qty, unit].filter(Boolean).join(' ');
		const note = ing.notes ? ` (${escapeMarkdown(ing.notes)})` : '';
		lines.push(`• ${prefix ? `${prefix} ` : ''}${escapeMarkdown(ing.name)}${note}`);
	}

	lines.push('');
	lines.push('**Instructions:**');
	recipe.instructions.forEach((step, i) => {
		lines.push(`${i + 1}. ${escapeMarkdown(step)}`);
	});

	if (recipe.macros) {
		lines.push('');
		const m = recipe.macros;
		const parts: string[] = [];
		if (m.calories) parts.push(`${m.calories} cal`);
		if (m.protein) parts.push(`${m.protein}g protein`);
		if (m.carbs) parts.push(`${m.carbs}g carbs`);
		if (m.fat) parts.push(`${m.fat}g fat`);
		if (m.fiber) parts.push(`${m.fiber}g fiber`);
		if (parts.length) lines.push(`Macros (per serving): ${parts.join(', ')}`);
	}

	return lines.join('\n');
```

In `formatSearchResults()` (line 272), escape the title and relevance. Replace line 284 with:

```ts
		lines.push(`${i + 1}. **${escapeMarkdown(recipe.title)}**${status}${rating} — ${escapeMarkdown(relevance)}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/food && npx vitest run src/__tests__/recipe-store.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/services/recipe-store.ts apps/food/src/__tests__/recipe-store.test.ts
git commit -m "fix: escape Markdown in formatRecipe and formatSearchResults (F9)"
```

---

### Task 4: Escape data in `formatPlanMessage()` and `formatTonightMessage()`

**Files:**
- Modify: `apps/food/src/services/meal-plan-store.ts:124-220`
- Modify: `apps/food/src/__tests__/meal-plan-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/food/src/__tests__/meal-plan-store.test.ts`, inside the `describe('formatPlanMessage')` block:

```ts
it('escapes Markdown control characters in dynamic fields', () => {
	const plan = makePlan({
		meals: [
			makeMeal({
				recipeTitle: "Mom's *Best* Pasta",
				isNew: true,
				description: 'A _wonderful_ new suggestion',
			}),
		],
	});

	const text = formatPlanMessage(plan, [], 'Raleigh, NC');

	expect(text).toContain("\\*Best\\*");
	expect(text).toContain('\\_wonderful\\_');
});
```

Add inside the `describe('formatTonightMessage')` block:

```ts
it('escapes Markdown control characters in recipe title and description', () => {
	const meal = makeMeal({ recipeTitle: "Chef's *Special* [Deluxe]" });
	const recipe = makeRecipe({
		instructions: ['Use `high heat` for _best_ results'],
	});

	const text = formatTonightMessage(meal, recipe);

	expect(text).toContain("\\*Special\\*");
	expect(text).toContain('\\[Deluxe\\]');
	expect(text).toContain('Use \\`high heat\\`');
	expect(text).toContain('\\_best\\_');
});

it('escapes description for new suggestions without recipe', () => {
	const meal = makeMeal({
		recipeTitle: '*New* Dish',
		description: 'Try this _amazing_ recipe',
	});

	const text = formatTonightMessage(meal, null);

	expect(text).toContain('\\*New\\*');
	expect(text).toContain('\\_amazing\\_');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/food && npx vitest run src/__tests__/meal-plan-store.test.ts`
Expected: FAIL — unescaped control characters

- [ ] **Step 3: Add escapeMarkdown to both formatters**

In `apps/food/src/services/meal-plan-store.ts`, add import at the top:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatPlanMessage()`, escape dynamic fields. Replace line 148 with:

```ts
		lines.push(`${day} —${newTag} ${escapeMarkdown(meal.recipeTitle)}${newLabel}`);
```

Replace line 157 (inside the recipe details block) with:

```ts
				if (recipe.cuisine) parts.push(escapeMarkdown(recipe.cuisine));
```

Replace line 163 (description for new suggestions) with:

```ts
			lines.push(escapeMarkdown(meal.description));
```

In `formatTonightMessage()`, replace line 191 with:

```ts
	lines.push(`🍽 Tonight: ${escapeMarkdown(meal.recipeTitle)}`);
```

Replace lines 210-211 (first step) with:

```ts
		const truncated = firstStep.length > 120 ? firstStep.slice(0, 119) + '…' : firstStep;
		lines.push(`Quick prep: ${escapeMarkdown(truncated)}`);
```

Replace lines 215-216 (description) with:

```ts
		lines.push(escapeMarkdown(meal.description));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/food && npx vitest run src/__tests__/meal-plan-store.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/services/meal-plan-store.ts apps/food/src/__tests__/meal-plan-store.test.ts
git commit -m "fix: escape Markdown in formatPlanMessage and formatTonightMessage (F9)"
```

---

### Task 5: Escape data in `formatGroceryMessage()` and `formatPantry()`

**Files:**
- Modify: `apps/food/src/services/grocery-store.ts:132-175`
- Modify: `apps/food/src/services/pantry-store.ts:205-241`
- Modify: `apps/food/src/__tests__/grocery-store.test.ts`
- Modify: `apps/food/src/__tests__/pantry-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/food/src/__tests__/grocery-store.test.ts`, inside the `describe('formatGroceryMessage')` block. Use the existing `makeList`/`makeItem` helper functions (already defined at the top of that test file):

```ts
it('escapes Markdown control characters in item names', () => {
	const list = makeList({
		items: [makeItem({ name: '*Organic* [Spinach]', department: 'Produce', quantity: 1, unit: 'bag' })],
	});

	const msg = formatGroceryMessage(list);

	// Apostrophes are not Markdown control chars — no escaping on those
	expect(msg).toContain('\\*Organic\\*');
	expect(msg).toContain('\\[Spinach\\]');
	// Intentional department bold is server-authored — still present
	expect(msg).toContain('*Produce*');
});
```

Add to `apps/food/src/__tests__/pantry-store.test.ts`, in a new `describe('formatPantry')` block (or inside existing one):

```ts
it('escapes Markdown control characters in item names and categories', () => {
	const items: PantryItem[] = [
		{
			name: '*Organic* Brown Sugar',
			quantity: '2 bags',
			category: 'Baking',
			addedAt: '2026-04-11',
			department: 'Baking',
		},
	];

	const text = formatPantry(items);

	expect(text).toContain('\\*Organic\\*');
	// Intentional category bold preserved
	expect(text).toContain('*Baking*');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/food && npx vitest run src/__tests__/grocery-store.test.ts src/__tests__/pantry-store.test.ts`
Expected: FAIL — unescaped control characters

- [ ] **Step 3: Add escapeMarkdown to both formatters**

In `apps/food/src/services/grocery-store.ts`, add import:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatGroceryMessage()`, replace line 156 with:

```ts
		lines.push(`${emoji} *${escapeMarkdown(dept)}*`);
```

Replace line 160 with:

```ts
		lines.push(`${check} ${escapeMarkdown(item.name)}${qty}`);
```

In `formatItemQty()`, replace lines 172-173 with:

```ts
	if (item.quantity != null) parts.push(String(item.quantity));
	if (item.unit) parts.push(escapeMarkdown(item.unit));
```

In `apps/food/src/services/pantry-store.ts`, add import:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatPantry()`, replace line 224 with:

```ts
		lines.push(`${emoji} *${escapeMarkdown(dept)}*`);
```

Replace line 226 with:

```ts
		lines.push(`• ${escapeMarkdown(item.name)} — ${escapeMarkdown(item.quantity)}`);
```

Replace line 234 with:

```ts
		lines.push(`📦 *${escapeMarkdown(cat)}*`);
```

Replace line 236 with:

```ts
		lines.push(`• ${escapeMarkdown(item.name)} — ${escapeMarkdown(item.quantity)}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/food && npx vitest run src/__tests__/grocery-store.test.ts src/__tests__/pantry-store.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/services/grocery-store.ts apps/food/src/services/pantry-store.ts apps/food/src/__tests__/grocery-store.test.ts apps/food/src/__tests__/pantry-store.test.ts
git commit -m "fix: escape Markdown in formatGroceryMessage and formatPantry (F9)"
```

---

### Task 6: Escape data in `formatChildProfile()` and `formatGuestProfile()`

**Files:**
- Modify: `apps/food/src/services/family-profiles.ts:156-189`
- Modify: `apps/food/src/services/guest-profiles.ts:88-105`
- Modify: `apps/food/src/__tests__/family-profiles.test.ts`
- Modify: `apps/food/src/__tests__/guest-profiles.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/food/src/__tests__/family-profiles.test.ts`, inside or after the `formatChildProfile` describe block:

```ts
it('escapes Markdown control characters in profile fields', () => {
	const log: ChildFoodLog = {
		profile: {
			name: 'Baby *Star*',
			birthDate: '2025-06-01',
			allergenStage: 'early',
			knownAllergens: ['tree_nuts'],
			avoidAllergens: ['peanut [severe]'],
			dietaryNotes: 'Likes `soft` foods',
		},
		introductions: [
			{
				food: '*Almond* Butter',
				date: '2026-04-10',
				accepted: true,
				allergenCategory: 'tree_nuts',
			},
		],
	};

	const text = formatChildProfile(log, '2026-04-11');

	expect(text).toContain('\\*Star\\*');
	expect(text).toContain('tree\\_nuts');
	expect(text).toContain('peanut \\[severe\\]');
	expect(text).toContain('Likes \\`soft\\` foods');
	expect(text).toContain('\\*Almond\\*');
	// Intentional bold markers preserved
	// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
	// mismatch deferred to Finding 21. Only assert data-field escaping here.
});
```

Add to `apps/food/src/__tests__/guest-profiles.test.ts`, inside or after the `formatGuestProfile` describe block:

```ts
it('escapes Markdown control characters in guest fields', () => {
	const guest: GuestProfile = {
		name: 'John *The Chef* Doe',
		dietaryRestrictions: ['no_pork'],
		allergies: ['shellfish [anaphylaxis]'],
		notes: 'Prefers `raw` vegetables',
		slug: 'john-the-chef-doe',
	};

	const text = formatGuestProfile(guest);

	expect(text).toContain('\\*The Chef\\*');
	expect(text).toContain('no\\_pork');
	expect(text).toContain('\\[anaphylaxis\\]');
	expect(text).toContain('Prefers \\`raw\\` vegetables');
	// Do NOT assert '**' — double-asterisk bold is a pre-existing legacy Markdown
	// mismatch deferred to Finding 21. Only assert data-field escaping here.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/food && npx vitest run src/__tests__/family-profiles.test.ts src/__tests__/guest-profiles.test.ts`
Expected: FAIL — unescaped control characters

- [ ] **Step 3: Add escapeMarkdown to both formatters**

In `apps/food/src/services/family-profiles.ts`, add import:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatChildProfile()`, replace line 161 with:

```ts
		`**${escapeMarkdown(profile.name)}** (${age})`,
```

Replace line 166 with:

```ts
		lines.push(`Safe allergens: ${profile.knownAllergens.map(escapeMarkdown).join(', ')}`);
```

Replace line 169 with:

```ts
		lines.push(`Avoid: ${profile.avoidAllergens.map(escapeMarkdown).join(', ')}`);
```

Replace line 172 with:

```ts
		lines.push(`Notes: ${escapeMarkdown(profile.dietaryNotes)}`);
```

Replace line 184 with:

```ts
			const allergen = intro.allergenCategory ? ` (${escapeMarkdown(intro.allergenCategory)})` : '';
			lines.push(`${emoji} ${escapeMarkdown(intro.food)}${allergen} — ${intro.date}`);
```

In `apps/food/src/services/guest-profiles.ts`, add import:

```ts
import { escapeMarkdown } from '../utils/escape-markdown.js';
```

In `formatGuestProfile()`, replace line 89 with:

```ts
	const lines: string[] = [`**${escapeMarkdown(guest.name)}**`];
```

Replace line 91 with:

```ts
		lines.push(`Diet: ${guest.dietaryRestrictions.map(escapeMarkdown).join(', ')}`);
```

Replace line 93 with:

```ts
		lines.push(`Allergies: ${guest.allergies.map(escapeMarkdown).join(', ')}`);
```

Replace line 101 with:

```ts
		lines.push(`Notes: ${escapeMarkdown(guest.notes)}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/food && npx vitest run src/__tests__/family-profiles.test.ts src/__tests__/guest-profiles.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/food/src/services/family-profiles.ts apps/food/src/services/guest-profiles.ts apps/food/src/__tests__/family-profiles.test.ts apps/food/src/__tests__/guest-profiles.test.ts
git commit -m "fix: escape Markdown in formatChildProfile and formatGuestProfile (F9)"
```

---

### Task 7: Escape user input in echo and notes apps

**Files:**
- Modify: `apps/echo/src/index.ts:1-2, 21, 36-37`
- Modify: `apps/echo/src/__tests__/echo.test.ts`
- Modify: `apps/notes/src/index.ts:1-2, 92`

- [ ] **Step 1: Write the failing echo test**

Add to `apps/echo/src/__tests__/echo.test.ts`, inside the `describe('handleMessage')` block:

```ts
it('escapes Markdown control characters in echoed text', async () => {
	const ctx = createTestMessageContext({ text: 'hello *world* and _test_' });

	await echo.handleMessage(ctx);

	expect(services.telegram.send).toHaveBeenCalledWith(
		'test-user',
		'hello \\*world\\* and \\_test\\_',
	);
});
```

Add inside the existing `describe('handleCommand')` block:

```ts
it('escapes Markdown control characters in command args', async () => {
	// biome-ignore lint/style/noNonNullAssertion: handleCommand is defined on echo module
	await echo.handleCommand!('/echo', ['*bold*', '_italic_'], createTestMessageContext());

	expect(services.telegram.send).toHaveBeenCalledWith(
		'test-user',
		'\\*bold\\* \\_italic\\_',
	);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/echo && npx vitest run`
Expected: FAIL — unescaped text

- [ ] **Step 3: Add escapeMarkdown to echo app**

In `apps/echo/src/index.ts`, add import:

```ts
import { escapeMarkdown } from '@pas/core/utils/escape-markdown';
```

Replace line 21 with:

```ts
	await services.telegram.send(ctx.userId, escapeMarkdown(ctx.text));
```

Replace line 37 with:

```ts
	await services.telegram.send(ctx.userId, escapeMarkdown(message));
```

- [ ] **Step 4: Run echo tests to verify they pass**

Run: `cd apps/echo && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Add escapeMarkdown to notes app**

In `apps/notes/src/index.ts`, add import:

```ts
import { escapeMarkdown } from '@pas/core/utils/escape-markdown';
```

Replace line 92 with:

```ts
	await services.telegram.send(ctx.userId, header + recent.map(escapeMarkdown).join('\n'));
```

- [ ] **Step 6: Run full test suite for echo and notes**

Run: `npx vitest run apps/echo apps/notes`
Expected: All tests PASS (notes has no test file, so only echo tests run — this is fine)

- [ ] **Step 7: Commit**

```bash
git add apps/echo/src/index.ts apps/echo/src/__tests__/echo.test.ts apps/notes/src/index.ts
git commit -m "fix: escape Markdown in echo and notes app Telegram sends (F9)"
```

---

### Task 8: Add `formatReportForTelegram()` with selective field escaping

`formatForTelegram()` (pure truncation) must not be changed — it would escape LLM summaries and server-owned Markdown like `_italic_` empty-section markers. Instead, add `formatReportForTelegram()` that escapes data-origin fields individually and leaves the LLM summary raw.

**Files:**
- Modify: `core/src/services/reports/report-formatter.ts`
- Modify: `core/src/services/reports/index.ts:326-338`
- Modify: `core/src/services/reports/__tests__/report-formatter.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe('formatReportForTelegram')` block to `core/src/services/reports/__tests__/report-formatter.test.ts`:

```ts
import { formatForTelegram, formatReport, formatReportForTelegram } from '../report-formatter.js';

describe('formatReportForTelegram', () => {
	it('escapes data fields: report name, description, section label, section content', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data [section]', content: 'Price is *high*', isEmpty: false },
		];

		const result = formatReportForTelegram(
			makeReport({ name: 'Budget *Report*', description: 'Covers [all] categories' }),
			sections,
		);

		expect(result).toContain('\\*Report\\*');
		expect(result).toContain('Covers \\[all\\] categories');
		expect(result).toContain('Data \\[section\\]');
		expect(result).toContain('Price is \\*high\\*');
	});

	it('does NOT escape LLM summary', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data', content: 'some data', isEmpty: false },
		];
		const summary = '*Bold* summary from _LLM_';

		const result = formatReportForTelegram(makeReport(), sections, summary);

		// LLM summary is trusted formatter output — preserved as-is
		expect(result).toContain('*Bold* summary from _LLM_');
		expect(result).not.toContain('\\*Bold\\*');
	});

	it('does not affect formatReport output (unescaped canonical markdown)', () => {
		const sections: CollectedSection[] = [
			{ label: 'Data', content: 'Price is *high*', isEmpty: false },
		];
		const markdown = formatReport(makeReport({ name: 'Budget *Report*' }), sections);

		// formatReport is for history/API — must stay unescaped
		expect(markdown).toContain('Budget *Report*');
		expect(markdown).toContain('Price is *high*');
	});

	it('truncates long reports and does not split escape sequences', () => {
		// Section content with special chars — after escaping adds backslashes,
		// pushing the total past 4000 chars
		const filler = 'x'.repeat(3990);
		const sections: CollectedSection[] = [
			{ label: 'S', content: filler + ' *end*', isEmpty: false },
		];

		const result = formatReportForTelegram(makeReport({ name: 'R', description: undefined }), sections);

		expect(result).toContain('...report truncated');
		// The content just before the truncation notice must not end with a lone backslash
		const beforeNotice = result.split('\n\n_...report truncated_')[0] ?? '';
		expect(beforeNotice).not.toMatch(/\\$/);
	});

	it('formatForTelegram remains a pure truncation helper (no escaping)', () => {
		const msg = 'Data with *asterisks* and _underscores_';
		// formatForTelegram must NOT escape — it is used for other purposes
		expect(formatForTelegram(msg)).toBe(msg);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run src/services/reports/__tests__/report-formatter.test.ts`
Expected: FAIL — `formatReportForTelegram` not exported, last test may fail if formatForTelegram was changed

- [ ] **Step 3: Add `formatReportForTelegram()` to the formatter**

In `core/src/services/reports/report-formatter.ts`, add import:

```ts
import { escapeMarkdown } from '../../utils/escape-markdown.js';
```

Add the new function after `formatForTelegram`:

```ts
/**
 * Format a report for Telegram delivery with selective Markdown escaping.
 *
 * Escapes data-origin fields (name, description, section labels/content) to
 * prevent Telegram parse errors, while leaving LLM summaries and server-owned
 * formatting markers (headers, italics) unescaped.
 */
export function formatReportForTelegram(
	report: ReportDefinition,
	sections: CollectedSection[],
	summary?: string,
	runDate?: string,
): string {
	const lines: string[] = [];

	// Header — report.name is user-configured data
	lines.push(`# ${escapeMarkdown(report.name)}`);
	if (runDate) {
		lines.push(`_Generated: ${runDate}_`); // runDate is server-formatted — safe
	}
	if (report.description) {
		lines.push('', escapeMarkdown(report.description));
	}

	// LLM Summary — trusted formatter output, not escaped
	if (summary) {
		lines.push('', '## Summary', '', summary);
	}

	// Sections — labels and content are user/data-origin, escape them
	for (const section of sections) {
		lines.push('', `## ${escapeMarkdown(section.label)}`);
		if (section.isEmpty) {
			lines.push('', `_${escapeMarkdown(section.content)}_`);
		} else {
			lines.push('', escapeMarkdown(section.content));
		}
	}

	lines.push('');
	const text = lines.join('\n');

	// Truncate to Telegram limit; back up past any dangling backslash
	const maxLength = 4000;
	if (text.length <= maxLength) return text;
	let cutAt = maxLength;
	if (text[cutAt - 1] === '\\') cutAt--;
	return `${text.slice(0, cutAt)}\n\n_...report truncated_`;
}
```

- [ ] **Step 4: Update `run()` in `ReportService` to use the new function**

In `core/src/services/reports/index.ts`, add `formatReportForTelegram` to the existing import from `./report-formatter.js`:

```ts
import { formatReport, formatReportForTelegram } from './report-formatter.js';
```

(`formatForTelegram` is no longer needed in `index.ts` — remove it from the import.)

In the `run()` method (around line 232), replace the `deliver()` call with a direct call that passes the structured data. Change:

```ts
await this.deliver(report, markdown);
```

to:

```ts
const telegramText = formatReportForTelegram(report, sections, summary, runDate);
await this.deliver(report, telegramText);
```

The `deliver()` method itself stays unchanged — it remains a simple string-sender that calls `telegram.send(userId, telegramText)` for each delivery user.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd core && npx vitest run src/services/reports/__tests__/`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add core/src/services/reports/report-formatter.ts core/src/services/reports/index.ts core/src/services/reports/__tests__/report-formatter.test.ts
git commit -m "fix: add formatReportForTelegram with selective field escaping (F9)"
```

---

### Task 9: Escape in alert `executeTelegramMessage()` (Telegram boundary only)

**Files:**
- Modify: `core/src/services/alerts/alert-executor.ts:266-277`
- Modify: `core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts`, inside the `describe('executeActions — telegram_message with templates')` block:

```ts
it('escapes {data} and {alert_name} in Telegram message', async () => {
	const deps = makeDeps();
	const actions: AlertAction[] = [
		{ type: 'telegram_message', config: { message: 'Alert: {alert_name} — {data}' } },
	];
	const ctx = makeContext({ data: 'Price *dropped* for [item]', alertName: 'My *Alert*' });

	await executeActions(actions, ['user1'], deps, ctx);

	const sentText = (deps.telegram.send as any).mock.calls[0][1];
	// data and alertName are escaped
	expect(sentText).toContain('\\*dropped\\*');
	expect(sentText).toContain('\\[item\\]');
	expect(sentText).toContain('My \\*Alert\\*');
});

it('resolveTemplate itself never escapes — summary and template stay raw', () => {
	// The escaping contract: executeTelegramMessage pre-escapes data/alertName
	// before calling resolveTemplate. resolveTemplate is a pure substitution function
	// with no knowledge of Markdown escaping. This guards against adding escaping there.
	const result = resolveTemplate('Alert: {alert_name}. Summary: {summary}', {
		data: '',
		summary: '*Bold* LLM output',
		alertName: 'My Alert',
		date: '2026-04-11',
	});

	// resolveTemplate must not escape anything — callers pre-escape what they need
	expect(result).toBe('Alert: My Alert. Summary: *Bold* LLM output');
	expect(result).not.toContain('\\*');
});

it('does not escape in resolveTemplate (shared with non-Telegram actions)', () => {
	const result = resolveTemplate('Data: {data}', {
		data: 'Price *dropped*',
		summary: '',
		alertName: 'test',
		date: '2026-04-11',
	});

	// resolveTemplate should NOT escape — it's shared with write_data, audio, dispatch
	expect(result).toBe('Data: Price *dropped*');
	expect(result).not.toContain('\\*');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd core && npx vitest run src/services/alerts/__tests__/alert-executor-enhanced.test.ts`
Expected: FAIL — first test fails (no escaping in telegram send), second test should PASS already

- [ ] **Step 3: Add escaping to `executeTelegramMessage()`**

Escape only the data-origin vars (`data`, `alertName`) before passing to `resolveTemplate()`. This leaves `summary` (LLM output) and `config.message` (server-authored Markdown template) unescaped, preserving intentional formatting in both.

In `core/src/services/alerts/alert-executor.ts`, add import at the top:

```ts
import { escapeMarkdown } from '../../utils/escape-markdown.js';
```

In `executeTelegramMessage()` (line 272), replace lines 272-277 with:

```ts
	// Escape data-origin vars to prevent Markdown parse errors.
	// summary (LLM output) and config.message (server-authored template) are left raw.
	const escapedVars = {
		...vars,
		data: escapeMarkdown(vars.data),
		alertName: escapeMarkdown(vars.alertName),
	};
	let text = resolveTemplate(config.message, escapedVars);

	// Truncate to Telegram limit
	if (text.length > MAX_TELEGRAM_LENGTH) {
		text = `${text.slice(0, MAX_TELEGRAM_LENGTH - 20)}\n\n_(truncated)_`;
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd core && npx vitest run src/services/alerts/__tests__/alert-executor-enhanced.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add core/src/services/alerts/alert-executor.ts core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts
git commit -m "fix: escape Markdown in executeTelegramMessage, not resolveTemplate (F9)"
```

---

### Task 10: Replace router/verifier MarkdownV2 escaping with shared utility

**Files:**
- Modify: `core/src/services/router/index.ts:29-32`
- Modify: `core/src/services/router/route-verifier.ts:57-60`

- [ ] **Step 1: Run existing router and verifier tests to establish baseline**

Run: `cd core && npx vitest run src/services/router/__tests__/`
Expected: All tests PASS

- [ ] **Step 2: Replace router inline escapeMarkdown**

In `core/src/services/router/index.ts`, add import at the top (near other imports):

```ts
import { escapeMarkdown } from '../../utils/escape-markdown.js';
```

Delete lines 29-32 (the inline `escapeMarkdown` function and its JSDoc comment):

```ts
/** Escape Telegram MarkdownV2 special characters in user-controlled text. */
function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
```

- [ ] **Step 3: Replace route-verifier inline escapeMarkdown**

In `core/src/services/router/route-verifier.ts`, add import at the top:

```ts
import { escapeMarkdown } from '../../utils/escape-markdown.js';
```

Delete lines 57-60 (the inline function and its JSDoc):

```ts
/** Escape special MarkdownV2 characters for Telegram. */
function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run router and verifier tests to verify no regressions**

Run: `cd core && npx vitest run src/services/router/__tests__/`
Expected: All tests PASS (no tests assert MarkdownV2-specific escaping of `.`, `!`, `-`, etc.)

- [ ] **Step 5: Commit**

```bash
git add core/src/services/router/index.ts core/src/services/router/route-verifier.ts
git commit -m "refactor: replace MarkdownV2 escapeMarkdown with shared legacy Markdown utility (F9)"
```

---

### Task 11: Update F9 finding status and run full test suite

**Files:**
- Modify: `docs/codebase-review-findings.md:267`

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All 5510+ tests pass, no failures

- [ ] **Step 2: Run build**

Run: `pnpm build`
Expected: No type errors

- [ ] **Step 3: Update finding status**

In `docs/codebase-review-findings.md`, change Finding 9 status on line 267:

```
- Status: open
```
to:
```
- Status: fixed
```

- [ ] **Step 4: Update CLAUDE.md test count if it increased**

Update the test count in `CLAUDE.md` if new tests pushed the total above 5510.

- [ ] **Step 5: Commit**

```bash
git add docs/codebase-review-findings.md CLAUDE.md
git commit -m "docs: mark F9 as fixed, update test count"
```
