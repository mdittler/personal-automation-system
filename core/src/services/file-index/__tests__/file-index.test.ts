import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileIndexService } from '../index.js';
import type { DataChangedPayload } from '../../../types/data-events.js';
import type { ManifestDataScope } from '../../../types/manifest.js';

function tempDir() {
  return join(tmpdir(), `pas-file-index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function writeDataFile(dataDir: string, relativePath: string, content: string) {
  const fullPath = join(dataDir, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

const RECIPE_CONTENT = `---
title: Chicken Tacos
type: recipe
tags:
  - pas/recipe
  - pas/food
entity_keys:
  - chicken
  - tacos
app: food
---
# Chicken Tacos
A delicious recipe.`;

const PRICE_CONTENT = `---
title: Costco Prices
type: price-list
tags:
  - pas/prices
  - pas/food
entity_keys:
  - costco
app: food
---
## Items
- Chicken $5.99`;

const DATED_CONTENT = `---
title: March Nutrition
type: nutrition-log
date: 2026-03-15
app: food
---
March nutrition data.`;

const makeScopes = (userPaths: string[], sharedPaths: string[]): { user: ManifestDataScope[]; shared: ManifestDataScope[] } => ({
  user: userPaths.map(path => ({ path, access: 'read-write' as const, description: '' })),
  shared: sharedPaths.map(path => ({ path, access: 'read-write' as const, description: '' })),
});

describe('FileIndexService', () => {
  let dataDir: string;
  let service: FileIndexService;
  const appScopes = new Map([
    ['food', makeScopes(['recipes/', 'nutrition/', 'health/'], ['prices/', 'recipes/'])],
    ['chatbot', makeScopes(['daily-notes/'], [])],
  ]);

  beforeEach(async () => {
    dataDir = tempDir();
    await mkdir(dataDir, { recursive: true });
    service = new FileIndexService(dataDir, appScopes);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('rebuild', () => {
    it('indexes user-scoped files within declared scopes', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.rebuild();

      const entries = service.getEntries({ appId: 'food' });
      expect(entries).toHaveLength(1);
      expect(entries[0].scope).toBe('user');
      expect(entries[0].owner).toBe('matt');
      expect(entries[0].appId).toBe('food');
      expect(entries[0].title).toBe('Chicken Tacos');
      expect(entries[0].type).toBe('recipe');
      expect(entries[0].entityKeys).toEqual(['chicken', 'tacos']);
    });

    it('indexes shared-scoped files', async () => {
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', PRICE_CONTENT);
      await service.rebuild();

      const entries = service.getEntries({ scope: 'shared' });
      expect(entries).toHaveLength(1);
      expect(entries[0].owner).toBeNull();
    });

    it('indexes space-scoped files using shared scopes', async () => {
      await writeDataFile(dataDir, 'spaces/family/food/recipes/pasta.yaml', RECIPE_CONTENT);
      await service.rebuild();

      const entries = service.getEntries({ scope: 'space' });
      expect(entries).toHaveLength(1);
      expect(entries[0].owner).toBe('family');
    });

    it('excludes archived files', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.2026-04-13_14-30-22.yaml', RECIPE_CONTENT);
      await service.rebuild();

      const entries = service.getEntries({ appId: 'food' });
      expect(entries).toHaveLength(1);
    });

    it('excludes files from unregistered apps', async () => {
      await writeDataFile(dataDir, 'users/matt/unregistered-app/data.md', '# Test');
      await service.rebuild();

      expect(service.getEntries({}).length).toBe(0);
    });

    it('excludes files outside declared manifest scopes', async () => {
      // 'budgets/' is not in food's declared user_scopes
      await writeDataFile(dataDir, 'users/matt/food/budgets/2026.yaml', RECIPE_CONTENT);
      await service.rebuild();

      expect(service.getEntries({}).length).toBe(0);
    });
  });

  describe('handleDataChanged', () => {
    it('re-indexes file on write event', async () => {
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', PRICE_CONTENT);
      await service.rebuild();
      expect(service.getEntries({}).length).toBe(1);

      const updated = PRICE_CONTENT.replace('Costco Prices', 'Updated Costco Prices');
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', updated);

      const payload: DataChangedPayload = {
        operation: 'write',
        appId: 'food',
        userId: null,
        path: 'prices/costco.md',
      };
      await service.handleDataChanged(payload);

      const entries = service.getEntries({});
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe('Updated Costco Prices');
    });

    it('removes entry on archive event', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.rebuild();
      expect(service.getEntries({}).length).toBe(1);

      const payload: DataChangedPayload = {
        operation: 'archive',
        appId: 'food',
        userId: 'matt',
        path: 'recipes/tacos.yaml',
      };
      await service.handleDataChanged(payload);

      expect(service.getEntries({}).length).toBe(0);
    });

    it('indexes space-scoped file from write event', async () => {
      await writeDataFile(dataDir, 'spaces/family/food/recipes/new.yaml', RECIPE_CONTENT);

      const payload: DataChangedPayload = {
        operation: 'write',
        appId: 'food',
        userId: 'matt',
        path: 'recipes/new.yaml',
        spaceId: 'family',
      };
      await service.handleDataChanged(payload);

      const entries = service.getEntries({ scope: 'space' });
      expect(entries).toHaveLength(1);
      expect(entries[0].owner).toBe('family');
    });

    it('reindexByPath updates an existing entry', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.rebuild();
      expect(service.getEntries({ appId: 'food' })).toHaveLength(1);
      expect(service.getEntries({ appId: 'food' })[0]!.title).toBe('Chicken Tacos');

      // Update the file on disk
      const updated = RECIPE_CONTENT.replace('Chicken Tacos', 'Updated Chicken Tacos');
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', updated);

      // Reindex via the public method
      await service.reindexByPath('users/matt/food/recipes/tacos.yaml');

      const entries = service.getEntries({ appId: 'food' });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.title).toBe('Updated Chicken Tacos');
    });
  });

  describe('getEntries filter', () => {
    beforeEach(async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', PRICE_CONTENT);
      await service.rebuild();
    });

    it('filters by type', () => {
      expect(service.getEntries({ type: 'recipe' })).toHaveLength(1);
      expect(service.getEntries({ type: 'price-list' })).toHaveLength(1);
      expect(service.getEntries({ type: 'nonexistent' })).toHaveLength(0);
    });

    it('filters by owner', () => {
      expect(service.getEntries({ owner: 'matt' })).toHaveLength(1);
    });

    it('filters by text search on title', () => {
      expect(service.getEntries({ text: 'tacos' })).toHaveLength(1);
      expect(service.getEntries({ text: 'costco' })).toHaveLength(1);
    });

    it('filters by text search on entityKeys', () => {
      expect(service.getEntries({ text: 'chicken' })).toHaveLength(1);
    });

    it('no filter returns all entries', () => {
      expect(service.getEntries()).toHaveLength(2);
    });

    describe('date range filtering', () => {
      beforeEach(async () => {
        await writeDataFile(dataDir, 'users/matt/food/nutrition/2026-03.yaml', DATED_CONTENT);
        await service.rebuild();
      });

      it('dateFrom includes file when dateFrom is before latest date', () => {
        // File dated 2026-03-15; dateFrom 2026-03-01 → latest (2026-03-15) >= dateFrom → included
        expect(service.getEntries({ appId: 'food', dateFrom: '2026-03-01' }).some(e => e.type === 'nutrition-log')).toBe(true);
      });

      it('dateFrom excludes file when dateFrom is after latest date', () => {
        // File dated 2026-03-15; dateFrom 2026-04-01 → latest (2026-03-15) < dateFrom → excluded
        expect(service.getEntries({ appId: 'food', dateFrom: '2026-04-01' }).some(e => e.type === 'nutrition-log')).toBe(false);
      });

      it('dateTo includes file when dateTo is after earliest date', () => {
        // File dated 2026-03-15; dateTo 2026-04-01 → earliest (2026-03-15) <= dateTo → included
        expect(service.getEntries({ appId: 'food', dateTo: '2026-04-01' }).some(e => e.type === 'nutrition-log')).toBe(true);
      });

      it('dateTo excludes file when dateTo is before earliest date', () => {
        // File dated 2026-03-15; dateTo 2026-03-01 → earliest (2026-03-15) > dateTo → excluded
        expect(service.getEntries({ appId: 'food', dateTo: '2026-03-01' }).some(e => e.type === 'nutrition-log')).toBe(false);
      });
    });
  });

  describe('getRelated', () => {
    it('returns frontmatter relationships and wiki-link edges', async () => {
      const withRelated = `---
title: Test
related:
  - prices/costco.md
---
Content with [[recipes/tacos]].`;
      await writeDataFile(dataDir, 'users/matt/chatbot/daily-notes/test.md', withRelated);
      await service.rebuild();

      const related = service.getRelated('users/matt/chatbot/daily-notes/test.md');
      expect(related).toContainEqual({ target: 'prices/costco.md', type: 'related' });
      expect(related).toContainEqual({ target: 'recipes/tacos', type: 'wiki-link' });
    });
  });

  describe('rebuild consistency with archive', () => {
    it('excludes archived files after rebuild', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.rebuild();
      expect(service.getEntries({}).length).toBe(1);

      // Simulate archive: original renamed, rebuild from scratch
      const { rm: rmFile } = await import('node:fs/promises');
      await rmFile(join(dataDir, 'users/matt/food/recipes/tacos.yaml'));
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.2026-04-13_14-30-22.yaml', RECIPE_CONTENT);

      await service.handleDataChanged({
        operation: 'archive',
        appId: 'food',
        userId: 'matt',
        path: 'recipes/tacos.yaml',
      });
      const afterEvent = service.getEntries({}).length;

      await service.rebuild();
      const afterRebuild = service.getEntries({}).length;

      expect(afterEvent).toBe(0);
      expect(afterRebuild).toBe(0);
    });
  });

  describe('size property', () => {
    it('returns total indexed count', async () => {
      await writeDataFile(dataDir, 'users/matt/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', PRICE_CONTENT);
      await service.rebuild();
      expect(service.size).toBe(2);
    });
  });

  describe('error handling', () => {
    it('handleDataChanged skips null payload gracefully', async () => {
      await service.handleDataChanged(null as any);
      expect(service.size).toBe(0);
    });

    it('handleDataChanged skips empty object payload gracefully', async () => {
      await service.handleDataChanged({} as any);
      expect(service.size).toBe(0);
    });

    it('handleDataChanged skips payload with invalid operation', async () => {
      // Write a file that would otherwise be indexed
      await writeDataFile(dataDir, 'users/shared/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.handleDataChanged({
        operation: 'delete' as any,
        appId: 'food',
        userId: null,
        path: 'recipes/tacos.yaml',
      });
      expect(service.size).toBe(0);
    });
  });

  describe('security', () => {
    it('handleDataChanged rejects path traversal in payload.path', async () => {
      // First index a valid file so size=1
      await writeDataFile(dataDir, 'users/shared/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await service.rebuild();

      await service.handleDataChanged({
        operation: 'write',
        appId: 'food',
        userId: null,
        path: '../../../etc/passwd',
      });
      expect(service.size).toBe(1); // only the original
    });

    it('handleDataChanged rejects userId with path separators', async () => {
      await service.handleDataChanged({
        operation: 'write',
        appId: 'food',
        userId: '../admin',
        path: 'recipes/evil.yaml',
      });
      expect(service.size).toBe(0);
    });

    it('handleDataChanged rejects spaceId with path traversal', async () => {
      await service.handleDataChanged({
        operation: 'write',
        appId: 'food',
        userId: 'matt',
        path: 'recipes/evil.yaml',
        spaceId: '../../etc',
      });
      expect(service.size).toBe(0);
    });

    it('handleDataChanged rejects appId with path separators', async () => {
      await service.handleDataChanged({
        operation: 'write',
        appId: 'food/../evil',
        userId: null,
        path: 'recipes/evil.yaml',
      });
      expect(service.size).toBe(0);
    });

    it('handleDataChanged rejects Windows drive-like path', async () => {
      await service.handleDataChanged({
        operation: 'write',
        appId: 'food',
        userId: null,
        path: 'C:/Windows/system32',
      });
      expect(service.size).toBe(0);
    });

    it('handleDataChanged rejects empty path', async () => {
      await service.handleDataChanged({
        operation: 'write',
        appId: 'food',
        userId: null,
        path: '',
      });
      expect(service.size).toBe(0);
    });

    it('reindexByPath rejects path traversal', async () => {
      await service.reindexByPath('../../etc/passwd');
      expect(service.size).toBe(0);
    });

    it('reindexByPath rejects absolute path', async () => {
      await service.reindexByPath('/etc/passwd');
      expect(service.size).toBe(0);
    });

    it('reindexByPath rejects empty string', async () => {
      await service.reindexByPath('');
      expect(service.size).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('concurrent handleDataChanged calls on same file resolve without corruption', async () => {
      await writeDataFile(dataDir, 'users/shared/food/prices/costco.md', PRICE_CONTENT);

      const payload: DataChangedPayload = {
        operation: 'write',
        appId: 'food',
        userId: null,
        path: 'prices/costco.md',
      };

      await Promise.all([
        service.handleDataChanged(payload),
        service.handleDataChanged(payload),
      ]);

      expect(service.getEntries({ appId: 'food' })).toHaveLength(1);
    });
  });

  describe('realistic household data', () => {
    let householdService: FileIndexService;

    // Representative subset of production scopes — covers the file types used in HOUSEHOLD_FILES.
    // The full food manifest has ~15 shared scopes; only those needed for this fixture are listed.
    // If you add files at a path not covered here (e.g., receipts/, photos/), add the scope too.
    const productionScopes = new Map([
      ['food', {
        user: [
          { path: 'nutrition/', access: 'read-write' as const, description: 'Nutrition logs' },
          { path: 'health/', access: 'read-write' as const, description: 'Health metrics' },
          { path: 'preferences.yaml', access: 'read-write' as const, description: 'Food preferences' },
        ],
        shared: [
          { path: 'recipes/', access: 'read-write' as const, description: 'Recipes' },
          { path: 'meal-plans/', access: 'read-write' as const, description: 'Meal plans' },
          { path: 'grocery/', access: 'read-write' as const, description: 'Grocery lists' },
          { path: 'pantry.yaml', access: 'read-write' as const, description: 'Pantry inventory' },
          { path: 'prices/', access: 'read-write' as const, description: 'Price tracking' },
          { path: 'cultural-calendar.yaml', access: 'read-write' as const, description: 'Cultural calendar' },
        ],
      }],
      ['chatbot', {
        user: [
          { path: 'history.json', access: 'read-write' as const, description: 'Chat history' },
          { path: 'daily-notes/', access: 'read-write' as const, description: 'Daily notes' },
        ],
        shared: [],
      }],
    ]);

    const HOUSEHOLD_FILES: Record<string, string> = {
      'users/shared/food/recipes/chicken-tacos.yaml': `---
title: Chicken Tacos
type: recipe
entity_keys:
  - chicken tacos
  - chicken
  - tortillas
  - cilantro
  - lime
tags:
  - pas/recipe
  - pas/food
date: 2026-03-10
app: food
---
# Chicken Tacos
A classic recipe. See [[pantry]] for spices.`,

      'users/shared/food/recipes/pasta-primavera.yaml': `---
title: Pasta Primavera
type: recipe
entity_keys:
  - pasta primavera
  - penne
  - zucchini
tags:
  - pas/recipe
date: 2026-02-15
app: food
---
Use fresh seasonal vegetables.`,

      'users/shared/food/prices/costco.md': `---
title: Costco Prices
type: price-list
entity_keys:
  - costco
  - costco-wholesale
tags:
  - pas/prices
app: food
---
## Produce
- Avocados $5.99/bag`,

      'users/shared/food/prices/trader-joes.md': `---
title: "Trader Joe's Prices"
type: price-list
entity_keys:
  - "trader joe's"
  - trader-joes
date: 2026-04-01
app: food
---
## Snacks
- Everything Bagels $3.49`,

      'users/shared/food/meal-plans/2026-W15.yaml': `---
title: Meal Plan 2026-W15
type: meal-plan
entity_keys:
  - 2026-W15
date: 2026-04-07
app: food
---
## Monday
- Dinner: [[recipes/chicken-tacos]]`,

      'users/matt/food/nutrition/2026-03.yaml': `---
title: Nutrition 2026-03
type: nutrition-log
date: 2026-03-15
app: food
---
month: 2026-03`,

      'users/matt/food/health/2026-03.yaml': `---
title: Health 2026-03
type: health-metrics
date: 2026-03-31
app: food
---
month: 2026-03`,

      'users/matt/chatbot/daily-notes/2026-04-13.md': `---
title: Daily Note 2026-04-13
type: daily-note
date: 2026-04-13
tags:
  - pas/daily-note
app: chatbot
---
Made [[recipes/chicken-tacos]] for dinner tonight.
Need to restock [[pantry]] with tortillas.`,
    };

    beforeEach(async () => {
      householdService = new FileIndexService(dataDir, productionScopes);
      for (const [path, content] of Object.entries(HOUSEHOLD_FILES)) {
        await writeDataFile(dataDir, path, content);
      }
      await householdService.rebuild();
    });

    it('indexes all household files', () => {
      expect(householdService.size).toBe(Object.keys(HOUSEHOLD_FILES).length);
    });

    it('text search "chicken" finds recipe', () => {
      const results = householdService.getEntries({ text: 'chicken' });
      expect(results.some(e => e.type === 'recipe' && e.title === 'Chicken Tacos')).toBe(true);
    });

    it('text search "costco" finds the price list', () => {
      // Only costco.md has 'costco' in its title or entity_keys; trader-joes.md does not
      const results = householdService.getEntries({ text: 'costco' });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('price-list');
    });

    it('text search "2026-W15" finds the meal plan', () => {
      const results = householdService.getEntries({ text: '2026-W15' });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('meal-plan');
    });

    it('filters all food recipes by type', () => {
      const recipes = householdService.getEntries({ appId: 'food', type: 'recipe' });
      expect(recipes).toHaveLength(2);
    });

    it('date range query for March 2026 returns relevant files', () => {
      const march = householdService.getEntries({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
      expect(march.some(e => e.type === 'nutrition-log')).toBe(true);
      expect(march.some(e => e.type === 'health-metrics')).toBe(true);
      expect(march.some(e => e.type === 'recipe' && e.title === 'Chicken Tacos')).toBe(true);
    });

    it('getRelated returns wiki-links from daily note to recipes and pantry', () => {
      const dailyNoteKey = 'users/matt/chatbot/daily-notes/2026-04-13.md';
      const related = householdService.getRelated(dailyNoteKey);
      expect(related.some(r => r.target === 'recipes/chicken-tacos')).toBe(true);
      expect(related.some(r => r.target === 'pantry')).toBe(true);
      expect(related.every(r => r.type === 'wiki-link')).toBe(true);
    });

    it('shared scope food files have null owner', () => {
      const shared = householdService.getEntries({ scope: 'shared', appId: 'food' });
      expect(shared.length).toBeGreaterThanOrEqual(4); // recipes, prices, meal-plan
      expect(shared.every(e => e.owner === null)).toBe(true);
    });

    it('user scope food files have correct owner', () => {
      const userFiles = householdService.getEntries({ scope: 'user', owner: 'matt', appId: 'food' });
      expect(userFiles.length).toBeGreaterThanOrEqual(2); // nutrition + health
      expect(userFiles.every(e => e.owner === 'matt')).toBe(true);
    });

    it('chatbot files are separate from food files', () => {
      const chatbotFiles = householdService.getEntries({ appId: 'chatbot' });
      const foodFiles = householdService.getEntries({ appId: 'food' });
      expect(chatbotFiles).toHaveLength(1);
      expect(foodFiles).toHaveLength(Object.keys(HOUSEHOLD_FILES).length - 1);
    });
  });

  describe('configuration edge cases', () => {
    it('empty appScopes map means zero files indexed', async () => {
      const emptyService = new FileIndexService(dataDir, new Map());
      await writeDataFile(dataDir, 'users/shared/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await emptyService.rebuild();
      expect(emptyService.size).toBe(0);
    });

    it('registered app with empty scopes indexes zero files', async () => {
      const emptyScopes = new Map([
        ['food', { user: [] as ManifestDataScope[], shared: [] as ManifestDataScope[] }],
      ]);
      const emptyService = new FileIndexService(dataDir, emptyScopes);
      await writeDataFile(dataDir, 'users/shared/food/recipes/tacos.yaml', RECIPE_CONTENT);
      await emptyService.rebuild();
      expect(emptyService.size).toBe(0);
    });

    it('non-existent data directory results in zero entries', async () => {
      const badService = new FileIndexService('/nonexistent/path/does/not/exist', appScopes);
      await badService.rebuild();
      expect(badService.size).toBe(0);
    });
  });
});
