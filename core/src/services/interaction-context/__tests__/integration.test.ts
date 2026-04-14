/**
 * Integration tests for InteractionContextService and related chatbot utilities.
 *
 * Tests:
 * 1. Receipt → context flow: record entry with filePaths, verify recentFilePaths plumbing
 * 2. 11-minute expiry: entries older than TTL are excluded by getRecent()
 * 3. Context summary format: formatInteractionContextSummary includes both action names
 * 4. extractRecentFilePaths deduplication: overlapping filePaths deduplicated
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InteractionContextServiceImpl } from '../index.js';
import type { InteractionEntry } from '../index.js';
import { formatInteractionContextSummary, extractRecentFilePaths } from '../../../../../apps/chatbot/src/index.js';

describe('InteractionContextService integration', () => {
  let service: InteractionContextServiceImpl;

  beforeEach(() => {
    service = new InteractionContextServiceImpl();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('receipt → context flow: recentFilePaths contains the recorded file path', () => {
    service.record('user1', {
      appId: 'food',
      action: 'receipt_captured',
      entityType: 'receipt',
      filePaths: ['receipts/r001.yaml'],
    });

    const entries = service.getRecent('user1');
    expect(entries).toHaveLength(1);

    // Simulate what the chatbot does: extract file paths for context hint
    const recentFilePaths = extractRecentFilePaths(entries);
    expect(recentFilePaths).toContain('receipts/r001.yaml');
  });

  it('11-minute expiry: entries older than TTL are excluded', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    service.record('user1', {
      appId: 'food',
      action: 'receipt_captured',
      filePaths: ['receipts/r001.yaml'],
    });

    // Advance time by 11 minutes (past the 10-minute TTL)
    vi.setSystemTime(now + 11 * 60 * 1000);

    const entries = service.getRecent('user1');
    expect(entries).toHaveLength(0);
  });

  it('context summary format: contains both action names', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    service.record('user1', {
      appId: 'food',
      action: 'receipt_captured',
    });

    // Record second entry 2 minutes later
    vi.setSystemTime(now + 2 * 60 * 1000);

    service.record('user1', {
      appId: 'food',
      action: 'grocery_updated',
    });

    const entries = service.getRecent('user1');
    expect(entries).toHaveLength(2);

    // Pass current time explicitly so relative-time rendering is deterministic
    const summary = formatInteractionContextSummary(entries, new Date(now + 2 * 60 * 1000));
    expect(summary).toContain('receipt_captured');
    expect(summary).toContain('grocery_updated');
  });

  it('extractRecentFilePaths: deduplicates overlapping file paths', () => {
    const sharedPath = 'shared/food/grocery-list.md';

    service.record('user1', {
      appId: 'food',
      action: 'grocery_updated',
      filePaths: [sharedPath, 'shared/food/pantry.md'],
    });

    service.record('user1', {
      appId: 'food',
      action: 'recipe_saved',
      filePaths: [sharedPath, 'shared/food/recipes/tacos.yaml'],
    });

    const entries = service.getRecent('user1');
    const paths = extractRecentFilePaths(entries);

    // No duplicates
    const unique = new Set(paths);
    expect(paths.length).toBe(unique.size);

    // All distinct paths are present
    expect(paths).toContain(sharedPath);
    expect(paths).toContain('shared/food/pantry.md');
    expect(paths).toContain('shared/food/recipes/tacos.yaml');
    // sharedPath appears exactly once
    expect(paths.filter((p) => p === sharedPath)).toHaveLength(1);
  });
});
