/**
 * Integration tests for EditService.
 *
 * Uses real temp dirs and real EditLog. Mocks: LLM, DataQueryService,
 * AppRegistry, ChangeLog, EventBus.
 *
 * Tests:
 * 1. Full /edit flow: propose → confirm → file written + changelog + event + audit
 * 2. Read-only file → access_denied error
 * 3. Concurrent confirms on same file → exactly one ok:true, one ok:false (stale)
 * 4. data:changed event payload verified after successful confirm
 * 5. Stale write protection: modify file between propose and confirm
 * 6. Expired proposal rejection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EditServiceImpl, EditLog } from '../index.js';
import type { EditProposal } from '../index.js';
import type { AppLogger } from '../../../types/app-module.js';
import type { LLMService } from '../../../types/llm.js';
import type { EventBusService } from '../../../types/events.js';
import type { AppManifest } from '../../../types/manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as AppLogger;
}

function makeEventBus(): EventBusService & { emitCalls: Array<[string, unknown]> } {
  const emitCalls: Array<[string, unknown]> = [];
  return {
    emit: vi.fn((event: string, payload: unknown) => { emitCalls.push([event, payload]); }),
    on: vi.fn(),
    off: vi.fn(),
    clearAll: vi.fn(),
    emitCalls,
  } as unknown as EventBusService & { emitCalls: Array<[string, unknown]> };
}

function makeChangeLog() {
  return {
    record: vi.fn().mockResolvedValue(undefined),
    getLogPath: vi.fn().mockReturnValue('/dev/null'),
  };
}

/**
 * Build a minimal AppRegistry stub with one app that has write access to `receipts/**.yaml`.
 */
function makeAppRegistry(access: 'read' | 'write' | 'read-write' = 'write') {
  const manifest: AppManifest = {
    pas_core_version: '1.0.0',
    app: { id: 'food', name: 'Food', description: 'Food app', version: '1.0.0' },
    requirements: {
      data: {
        user_scopes: [
          {
            path: 'receipts/',
            access,
            description: 'User receipt files',
          },
        ],
      },
    },
  };

  return {
    getApp: vi.fn().mockReturnValue({ manifest, module: {}, appDir: '/apps/food' }),
  };
}

/**
 * Build a DataQueryService stub that returns a single file at the given path.
 */
function makeDataQuery(filePath: string, appId = 'food') {
  return {
    query: vi.fn().mockResolvedValue({
      files: [
        {
          path: filePath,
          appId,
          type: 'receipt',
          title: 'Test Receipt',
          content: '',
        },
      ],
      empty: false,
    }),
  };
}

/**
 * Build an LLM stub that returns the given modified content.
 */
function makeLlm(modifiedContent: string, delayMs = 0) {
  return {
    complete: vi.fn().mockImplementation(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return modifiedContent;
    }),
  } as unknown as LLMService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditService integration', () => {
  let tempDir: string;
  let dataDir: string;
  let editLogPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pas-edit-'));
    dataDir = join(tempDir, 'data');
    editLogPath = join(tempDir, 'edit-log.jsonl');
    // Create basic data directory structure
    await mkdir(join(dataDir, 'users', 'user1', 'food', 'receipts'), { recursive: true });
    await mkdir(join(dataDir, 'system'), { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Full /edit flow
  // -------------------------------------------------------------------------
  it('propose → confirm → file written, changelog, event, and audit log updated', async () => {
    const beforeContent = '# My Receipt\n\nItem: Apple\nPrice: $1.00\n';
    const afterContent = '# My Receipt\n\nItem: Apple\nPrice: $1.50\n';
    const relPath = 'users/user1/food/receipts/r001.md';
    const absPath = join(dataDir, relPath);

    await writeFile(absPath, beforeContent, 'utf-8');

    const changeLog = makeChangeLog();
    const eventBus = makeEventBus();
    const appRegistry = makeAppRegistry('write');

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: appRegistry as any,
      llm: makeLlm(afterContent),
      changeLog: changeLog as any,
      eventBus: eventBus as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    // Step 1: Propose
    const result = await editService.proposeEdit('increase the apple price to $1.50', 'user1');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;

    const proposal = result as EditProposal;
    expect(proposal.diff).not.toBe('');
    expect(proposal.diff).toContain('+');

    // Step 2: Confirm
    const confirmResult = await editService.confirmEdit(proposal);
    expect(confirmResult.ok).toBe(true);

    // File should have new content
    const writtenContent = await readFile(absPath, 'utf-8');
    expect(writtenContent).toBe(afterContent);

    // ChangeLog should have been called
    expect(changeLog.record).toHaveBeenCalledTimes(1);
    expect(changeLog.record).toHaveBeenCalledWith('write', relPath, 'food', 'user1');

    // EventBus should emit data:changed
    expect(eventBus.emitCalls).toHaveLength(1);
    const [eventName, payload] = eventBus.emitCalls[0];
    expect(eventName).toBe('data:changed');
    expect((payload as any).path).toBe(relPath);
    expect((payload as any).appId).toBe('food');

    // Audit log should contain a 'confirmed' entry
    const logContent = await readFile(editLogPath, 'utf-8');
    const entries = logContent.trim().split('\n').map((l) => JSON.parse(l));
    const confirmed = entries.find((e) => e.outcome === 'confirmed');
    expect(confirmed).toBeDefined();
    expect(confirmed.userId).toBe('user1');
    expect(confirmed.filePath).toBe(relPath);
  });

  // -------------------------------------------------------------------------
  // Test 2: Read-only file → access_denied
  // -------------------------------------------------------------------------
  it('read-only file → kind: error, action: access_denied', async () => {
    const relPath = 'users/user1/food/receipts/r001.md';
    const absPath = join(dataDir, relPath);
    await writeFile(absPath, '# readonly\n', 'utf-8');

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: makeAppRegistry('read') as any,
      llm: makeLlm('') as any,
      changeLog: makeChangeLog() as any,
      eventBus: makeEventBus() as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    const result = await editService.proposeEdit('change the title', 'user1');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('access_denied');
  });

  // -------------------------------------------------------------------------
  // Test 3: Concurrent confirms → second gets stale rejection
  // -------------------------------------------------------------------------
  it('concurrent confirms: exactly one ok:true and one ok:false (stale)', async () => {
    const beforeContent = '# Receipt\n\nPrice: $5\n';
    // The LLM stub always returns afterContent1; afterContent2 is a distinct string
    // placed in proposal2 to make the proposals different. The actual written content
    // is whichever proposal wins the race (first writer wins), so we only assert
    // that exactly one confirm succeeds and one fails — not the final file content.
    const afterContent1 = '# Receipt\n\nPrice: $6\n';
    const relPath = 'users/user1/food/receipts/r002.md';
    const absPath = join(dataDir, relPath);
    await writeFile(absPath, beforeContent, 'utf-8');

    const beforeHash = createHash('sha256').update(beforeContent).digest('hex');

    // Build two proposals with the same beforeHash (same baseline file)
    const sharedProposalBase = {
      kind: 'proposal' as const,
      filePath: relPath,
      absolutePath: absPath,
      appId: 'food',
      userId: 'user1',
      description: 'concurrent test',
      scope: 'user',
      beforeContent,
      beforeHash,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const proposal1: EditProposal = { ...sharedProposalBase, afterContent: afterContent1, diff: '...' };
    // proposal2 has a different afterContent string — the actual value doesn't matter since first writer wins
    const proposal2: EditProposal = { ...sharedProposalBase, afterContent: '# Receipt\n\nPrice: $7\n', diff: '...' };

    const changeLog = makeChangeLog();
    const eventBus = makeEventBus();

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: makeAppRegistry('write') as any,
      llm: makeLlm(afterContent1),
      changeLog: changeLog as any,
      eventBus: eventBus as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    // Fire both concurrently
    const [r1, r2] = await Promise.all([
      editService.confirmEdit(proposal1),
      editService.confirmEdit(proposal2),
    ]);

    const okCount = [r1, r2].filter((r) => r.ok).length;
    const failCount = [r1, r2].filter((r) => !r.ok).length;

    expect(okCount).toBe(1);
    expect(failCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 4: data:changed event payload verified
  // -------------------------------------------------------------------------
  it('eventBus.emit called with correct event name and payload after confirm', async () => {
    const beforeContent = '# Notes\n\nsome text\n';
    const afterContent = '# Notes\n\nupdated text\n';
    const relPath = 'users/user1/food/receipts/notes.md';
    const absPath = join(dataDir, relPath);
    await writeFile(absPath, beforeContent, 'utf-8');

    const eventBus = makeEventBus();

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: makeAppRegistry('write') as any,
      llm: makeLlm(afterContent),
      changeLog: makeChangeLog() as any,
      eventBus: eventBus as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    const proposal = await editService.proposeEdit('update text', 'user1');
    expect(proposal.kind).toBe('proposal');
    if (proposal.kind !== 'proposal') return;

    await editService.confirmEdit(proposal);

    expect(eventBus.emit).toHaveBeenCalledWith('data:changed', {
      path: relPath,
      appId: 'food',
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: Stale write protection
  // -------------------------------------------------------------------------
  it('stale write protection: file modified between propose and confirm → ok:false', async () => {
    const beforeContent = '# Original\n\noriginal content\n';
    const afterContent = '# Original\n\nedited content\n';
    const relPath = 'users/user1/food/receipts/stale.md';
    const absPath = join(dataDir, relPath);
    await writeFile(absPath, beforeContent, 'utf-8');

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: makeAppRegistry('write') as any,
      llm: makeLlm(afterContent),
      changeLog: makeChangeLog() as any,
      eventBus: makeEventBus() as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    const proposal = await editService.proposeEdit('edit content', 'user1');
    expect(proposal.kind).toBe('proposal');
    if (proposal.kind !== 'proposal') return;

    // Simulate another write between propose and confirm
    await writeFile(absPath, '# Modified\n\nconcurrently changed\n', 'utf-8');

    const result = await editService.confirmEdit(proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/modified since/i);
  });

  // -------------------------------------------------------------------------
  // Test 6: Expired proposal rejection
  // -------------------------------------------------------------------------
  it('expired proposal: ok:false with "expired" reason', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const beforeContent = '# Entry\n\nsome data\n';
    const afterContent = '# Entry\n\nchanged data\n';
    const relPath = 'users/user1/food/receipts/expiry.md';
    const absPath = join(dataDir, relPath);
    await writeFile(absPath, beforeContent, 'utf-8');

    const editService = new EditServiceImpl({
      dataQueryService: makeDataQuery(relPath) as any,
      appRegistry: makeAppRegistry('write') as any,
      llm: makeLlm(afterContent),
      changeLog: makeChangeLog() as any,
      eventBus: makeEventBus() as any,
      dataDir,
      logger: makeLogger(),
      editLog: new EditLog(editLogPath),
    });

    const proposal = await editService.proposeEdit('change data', 'user1');
    expect(proposal.kind).toBe('proposal');
    if (proposal.kind !== 'proposal') return;

    // Advance time past the 5-minute expiry
    vi.setSystemTime(now + 6 * 60 * 1000);

    const result = await editService.confirmEdit(proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.toLowerCase()).toContain('expir');
  });
});
