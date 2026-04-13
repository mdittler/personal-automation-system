import { describe, expect, it } from 'vitest';
import { parsePathMeta, parseFileContent, isArchived } from '../entry-parser.js';

describe('parsePathMeta', () => {
  it('parses user-scoped path', () => {
    const meta = parsePathMeta('users/matt/food/recipes/tacos.yaml');
    expect(meta).toEqual({
      appId: 'food',
      scope: 'user',
      owner: 'matt',
    });
  });

  it('parses shared-scoped path', () => {
    const meta = parsePathMeta('users/shared/food/prices/costco.md');
    expect(meta).toEqual({
      appId: 'food',
      scope: 'shared',
      owner: null,
    });
  });

  it('parses space-scoped path', () => {
    const meta = parsePathMeta('spaces/family/food/recipes/pasta.yaml');
    expect(meta).toEqual({
      appId: 'food',
      scope: 'space',
      owner: 'family',
    });
  });

  it('returns unknown appId for unrecognized path structure', () => {
    const meta = parsePathMeta('random/file.md');
    expect(meta.appId).toBe('unknown');
  });
});

describe('parseFileContent', () => {
  it('extracts frontmatter fields', () => {
    const content = `---
title: Costco Prices
type: price-list
tags:
  - pas/food
  - pas/prices
entity_keys:
  - costco
  - costco-wholesale
aliases:
  - Costco Wholesale
related:
  - prices/walmart.md
---
## Items
- Chicken $5.99`;

    const result = parseFileContent(content);
    expect(result.title).toBe('Costco Prices');
    expect(result.type).toBe('price-list');
    expect(result.tags).toEqual(['pas/food', 'pas/prices']);
    expect(result.entityKeys).toEqual(['costco', 'costco-wholesale']);
    expect(result.aliases).toEqual(['Costco Wholesale']);
    expect(result.relationships).toEqual([
      { target: 'prices/walmart.md', type: 'related' },
    ]);
  });

  it('extracts wiki-links from body', () => {
    const content = `---
title: Test
---
See [[recipes/tacos]] and [[pantry]].`;

    const result = parseFileContent(content);
    expect(result.wikiLinks).toEqual(['recipes/tacos', 'pantry']);
  });

  it('extracts title from first heading when no frontmatter title', () => {
    const content = `---
type: recipe
---
# Chicken Tacos

Delicious tacos.`;

    const result = parseFileContent(content);
    expect(result.title).toBe('Chicken Tacos');
  });

  it('extracts summary from first non-heading paragraph', () => {
    const content = `---
title: Test
---
# Heading

This is the summary paragraph.

More content here.`;

    const result = parseFileContent(content);
    expect(result.summary).toBe('This is the summary paragraph.');
  });

  it('extracts path-like source as relationship', () => {
    const content = `---
title: Test
source: recipes/original.yaml
---
Content`;

    const result = parseFileContent(content);
    expect(result.relationships).toEqual([
      { target: 'recipes/original.yaml', type: 'source' },
    ]);
  });

  it('ignores non-path source values (labels)', () => {
    const content = `---
title: Test
source: pas-chatbot
---
Content`;

    const result = parseFileContent(content);
    expect(result.relationships).toEqual([]);
  });

  it('extracts dates from frontmatter', () => {
    const content = `---
title: Test
date: 2026-03-15
created: 2026-03-10
---
Content`;

    const result = parseFileContent(content);
    expect(result.dates).toEqual({
      earliest: '2026-03-10',
      latest: '2026-03-15',
    });
  });

  it('handles file with no frontmatter', () => {
    const content = `# Just a heading\n\nSome content.`;
    const result = parseFileContent(content);
    expect(result.title).toBe('Just a heading');
    expect(result.type).toBeNull();
    expect(result.tags).toEqual([]);
  });
});

describe('isArchived', () => {
  it('detects archived filename', () => {
    expect(isArchived('recipe.2026-04-13_14-30-22.yaml')).toBe(true);
  });

  it('rejects normal filename', () => {
    expect(isArchived('recipe.yaml')).toBe(false);
  });

  it('rejects date-named files', () => {
    expect(isArchived('2026-03-15.md')).toBe(false);
  });
});
