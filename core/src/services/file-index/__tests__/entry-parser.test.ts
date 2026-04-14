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

describe('parseFileContent — edge cases', () => {
  it('handles empty file content', () => {
    const result = parseFileContent('');
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
    expect(result.tags).toEqual([]);
    expect(result.wikiLinks).toEqual([]);
  });

  it('handles file with only frontmatter and no body', () => {
    const content = '---\ntitle: Test\ntype: recipe\n---';
    const result = parseFileContent(content);
    expect(result.title).toBe('Test');
    expect(result.type).toBe('recipe');
    expect(result.summary).toBeNull();
  });

  it('handles unclosed frontmatter block — parser returns empty meta', () => {
    // parseFrontmatter() returns { meta: {}, content: raw } when no closing --- is found
    // so title and type will be null (empty meta), not parsed from the frontmatter block
    const content = '---\ntitle: Test\ntype: recipe\nSome body text';
    const result = parseFileContent(content);
    expect(result.title).toBeNull();
    expect(result.type).toBeNull();
  });

  it('handles entity_keys with special YAML characters', () => {
    const content = `---
title: "Grandma's Recipe: The Best"
type: recipe
entity_keys:
  - "grandma's recipe: the best"
  - "bell peppers (red)"
---
Body.`;
    const result = parseFileContent(content);
    expect(result.entityKeys).toContain("grandma's recipe: the best");
    expect(result.entityKeys).toContain("bell peppers (red)");
  });

  it('rejects invalid month in date field (month 00)', () => {
    const content = `---\ndate: 9999-00-01\n---\nBody.`;
    const result = parseFileContent(content);
    expect(result.dates.earliest).toBeNull();
  });

  it('rejects invalid month in date field (month 13)', () => {
    const content = `---\ndate: 2026-13-01\n---\nBody.`;
    const result = parseFileContent(content);
    expect(result.dates.earliest).toBeNull();
  });

  it('rejects invalid day in date field (day 00)', () => {
    const content = `---\ndate: 2026-04-00\n---\nBody.`;
    const result = parseFileContent(content);
    expect(result.dates.earliest).toBeNull();
  });
});

describe('parseFileContent — realistic user content', () => {
  it('parses recipe with unicode and apostrophes', () => {
    const content = `---
title: "Abuela's Arroz con Pollo"
type: recipe
app: food
entity_keys:
  - "abuela's arroz con pollo"
  - chicken
  - rice
  - saffron
tags:
  - pas/recipe
  - pas/food
date: 2026-03-15
---
A classic recipe. See [[pantry]] for spices and [[recipes/sofrito]] for the base.`;
    const result = parseFileContent(content);
    expect(result.title).toBe("Abuela's Arroz con Pollo");
    expect(result.type).toBe('recipe');
    expect(result.entityKeys).toContain("abuela's arroz con pollo");
    expect(result.wikiLinks).toContain('pantry');
    expect(result.wikiLinks).toContain('recipes/sofrito');
    expect(result.dates.earliest).toBe('2026-03-15');
  });

  it('parses price list with hyphenated store name', () => {
    const content = `---
title: "H-E-B Prices"
type: price-list
app: food
entity_keys:
  - h-e-b
  - heb
tags:
  - pas/prices
  - pas/food
date: 2026-04-01
---
## Produce
- Avocados: $1.29 each`;
    const result = parseFileContent(content);
    expect(result.title).toBe('H-E-B Prices');
    expect(result.type).toBe('price-list');
    expect(result.entityKeys).toContain('h-e-b');
    expect(result.tags).toContain('pas/prices');
  });

  it('parses meal plan with wiki-links to recipes', () => {
    const content = `---
title: Meal Plan 2026-W15
type: meal-plan
app: food
entity_keys:
  - 2026-W15
date: 2026-04-07
tags:
  - pas/meal-plan
  - pas/food
---
## Monday
- Dinner: [[recipes/chicken-tacos]]
## Tuesday
- Dinner: [[recipes/pasta-primavera]]`;
    const result = parseFileContent(content);
    expect(result.title).toBe('Meal Plan 2026-W15');
    expect(result.wikiLinks).toContain('recipes/chicken-tacos');
    expect(result.wikiLinks).toContain('recipes/pasta-primavera');
    expect(result.entityKeys).toContain('2026-W15');
  });

  it('parses daily note with cross-app wiki-links', () => {
    const content = `---
title: Daily Note 2026-04-13
type: daily-note
app: chatbot
date: 2026-04-13
tags:
  - pas/daily-note
---
Made [[recipes/chicken-tacos]] for dinner tonight.
Need to restock [[pantry]] with tortillas.
Checked [[grocery/active]] list.`;
    const result = parseFileContent(content);
    expect(result.title).toBe('Daily Note 2026-04-13');
    expect(result.type).toBe('daily-note');
    expect(result.wikiLinks).toContain('recipes/chicken-tacos');
    expect(result.wikiLinks).toContain('pantry');
    expect(result.wikiLinks).toContain('grocery/active');
    expect(result.dates.earliest).toBe('2026-04-13');
  });

  it('parses nutrition log with month date', () => {
    const content = `---
title: Nutrition 2026-03
type: nutrition-log
app: food
date: 2026-03-01
tags:
  - pas/nutrition
  - pas/food
---
month: 2026-03`;
    const result = parseFileContent(content);
    expect(result.title).toBe('Nutrition 2026-03');
    expect(result.type).toBe('nutrition-log');
    expect(result.dates.earliest).toBe('2026-03-01');
    expect(result.tags).toContain('pas/nutrition');
  });

  it('parses receipt from OCR with entity_keys', () => {
    const content = `---
title: "TRADER JOE'S #123 — 2026-04-01"
type: receipt
app: food
entity_keys:
  - "trader joe's"
  - trader-joes
date: 2026-04-01
tags:
  - pas/receipt
  - pas/food
---
Receipt scanned via photo.`;
    const result = parseFileContent(content);
    expect(result.title).toContain("TRADER JOE'S");
    expect(result.type).toBe('receipt');
    expect(result.entityKeys).toContain("trader joe's");
    expect(result.dates.earliest).toBe('2026-04-01');
  });
});

describe('parseFileContent — D2a enrichment compatibility', () => {
  it('parses all D2a fields correctly when present together', () => {
    const content = `---
title: Test Recipe
type: recipe
app: food
entity_keys:
  - test recipe
  - chicken
  - rice
tags:
  - pas/recipe
  - pas/food
date: 2026-04-13
related:
  - prices/costco.md
aliases:
  - My Test Recipe
---
# Test Recipe

A test recipe body with [[pantry]] link.
`;
    const result = parseFileContent(content);
    expect(result.title).toBe('Test Recipe');
    expect(result.type).toBe('recipe');
    expect(result.tags).toEqual(['pas/recipe', 'pas/food']);
    expect(result.entityKeys).toEqual(['test recipe', 'chicken', 'rice']);
    expect(result.aliases).toEqual(['My Test Recipe']);
    expect(result.dates.earliest).toBe('2026-04-13');
    expect(result.wikiLinks).toEqual(['pantry']);
    expect(result.relationships).toEqual([{ target: 'prices/costco.md', type: 'related' }]);
    // Summary should be the first non-heading body line
    expect(result.summary).toContain('test recipe body');
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
