/**
 * Integration tests for InteractionContextService (core service only).
 *
 * Tests:
 * 1. Receipt → context flow: record entry with filePaths, verify recentFilePaths plumbing
 * 2. 11-minute expiry: entries older than TTL are excluded by getRecent()
 *
 * Note: Tests for formatInteractionContextSummary and extractRecentFilePaths
 * (chatbot utility functions) live in apps/chatbot/src/__tests__/context-injection.test.ts
 * to avoid a cross-package import from core into apps/chatbot.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InteractionContextServiceImpl } from '../index.js';

describe('InteractionContextService integration', () => {
  let service: InteractionContextServiceImpl;

  beforeEach(() => {
    service = new InteractionContextServiceImpl();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('receipt → context flow: recorded entry is returned by getRecent with correct filePaths', () => {
    service.record('user1', {
      appId: 'food',
      action: 'receipt_captured',
      entityType: 'receipt',
      filePaths: ['receipts/r001.yaml'],
    });

    const entries = service.getRecent('user1');
    expect(entries).toHaveLength(1);
    expect(entries[0].filePaths).toContain('receipts/r001.yaml');
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
});
