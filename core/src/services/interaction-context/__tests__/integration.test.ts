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
import { requestContext } from '../../context/request-context.js';
import { UserBoundaryError } from '../../household/index.js';

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

describe('InteractionContextService — actor check (H5)', () => {
  let service: InteractionContextServiceImpl;

  beforeEach(() => {
    service = new InteractionContextServiceImpl();
    service.record('me', { appId: 'food', action: 'view-recipe' });
    service.record('other-user', { appId: 'notes', action: 'create-note' });
  });

  it('getRecent(me) from within runWithContext({ userId: me }) succeeds', async () => {
    let entries: ReturnType<typeof service.getRecent> | undefined;
    await requestContext.run({ userId: 'me' }, async () => {
      entries = service.getRecent('me');
    });
    expect(entries).toHaveLength(1);
    expect(entries![0]!.action).toBe('view-recipe');
  });

  it('getRecent(other-user) from within runWithContext({ userId: me }) throws UserBoundaryError', async () => {
    await expect(
      requestContext.run({ userId: 'me' }, async () => {
        service.getRecent('other-user');
      }),
    ).rejects.toThrow(UserBoundaryError);
  });

  it('getRecent(any) with no context (actorId undefined) succeeds (system use case)', () => {
    // No requestContext.run wrapper — actorId is undefined
    const entries = service.getRecent('other-user');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.action).toBe('create-note');
  });
});
