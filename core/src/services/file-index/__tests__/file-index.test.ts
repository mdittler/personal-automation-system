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
});
