/**
 * Tests for EditService — propose/confirm file edits with LLM generation,
 * SHA-256 stale-write protection, per-path locking, and audit logging.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataQueryServiceImpl } from '../../data-query/index.js';
import type { FileIndexService } from '../../file-index/index.js';
import type { AppRegistry } from '../../app-registry/index.js';
import type { SpaceService } from '../../spaces/index.js';
import type { ChangeLog } from '../../data-store/change-log.js';
import type { LLMService } from '../../../types/llm.js';
import type { EventBusService } from '../../../types/events.js';
import type { AppLogger } from '../../../types/app-module.js';
import { EditLog, EditServiceImpl } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return join(tmpdir(), `edit-test-${randomBytes(6).toString('hex')}`);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeLogger(): AppLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as AppLogger;
}

function makeEventBus(): EventBusService {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function makeChangeLog(): ChangeLog {
  return {
    record: vi.fn().mockResolvedValue(undefined),
    getLogPath: vi.fn().mockReturnValue('/tmp/change-log.jsonl'),
  } as unknown as ChangeLog;
}

function makeEditLog(): EditLog {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as EditLog;
}

/** Build a minimal AppRegistry with one app that has write access to a scope. */
function makeAppRegistry(opts: {
  appId: string;
  scopePath: string;
  access: 'read' | 'write' | 'read-write';
  scope?: 'user' | 'shared' | 'space';
}): AppRegistry {
  const manifest = {
    app: { id: opts.appId, name: opts.appId, version: '1.0.0', description: '', author: '' },
    requirements: {
      data: {
        user_scopes: opts.scope === 'shared' ? [] : [
          { path: opts.scopePath, access: opts.access, description: 'test scope' },
        ],
        shared_scopes: opts.scope === 'shared' ? [
          { path: opts.scopePath, access: opts.access, description: 'test scope' },
        ] : [],
      },
    },
  };
  return {
    getApp: vi.fn().mockReturnValue({ manifest, module: {}, appDir: '/apps/test' }),
    getAll: vi.fn().mockReturnValue([{ manifest, module: {}, appDir: '/apps/test' }]),
    getManifestCache: vi.fn(),
    getLoadedAppIds: vi.fn().mockReturnValue([opts.appId]),
    shutdownAll: vi.fn(),
  } as unknown as AppRegistry;
}

function makeSpaceService(): SpaceService {
  return {
    isMember: vi.fn().mockReturnValue(true),
    listSpaces: vi.fn().mockReturnValue([]),
    getSpacesForUser: vi.fn().mockReturnValue([]),
  } as unknown as SpaceService;
}

function makeLLM(returnValue: string): LLMService {
  return {
    complete: vi.fn().mockResolvedValue(returnValue),
    classify: vi.fn(),
    extractStructured: vi.fn(),
  } as unknown as LLMService;
}

function makeFileIndex(): FileIndexService {
  return {
    getEntries: vi.fn().mockReturnValue([]),
    getEntriesByScope: vi.fn().mockReturnValue([]),
    rebuild: vi.fn().mockResolvedValue(undefined),
    reindexByPath: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileIndexService;
}

// ---------------------------------------------------------------------------
// Default DataQueryResult builders
// ---------------------------------------------------------------------------

function makeDataQueryService(files: Array<{ path: string; appId: string; content: string }>): DataQueryServiceImpl {
  return {
    query: vi.fn().mockResolvedValue({ files, empty: files.length === 0 }),
  } as unknown as DataQueryServiceImpl;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('EditServiceImpl', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(dataDir, 'system'), { recursive: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Valid proposal returns kind: 'proposal'
  // -------------------------------------------------------------------------

  it('proposeEdit: valid → returns kind: proposal with correct fields', async () => {
    // Arrange: write a real file with frontmatter
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = '---\ntitle: Tacos\ntype: recipe\n---\n\n## Ingredients\n- beef\n- cheese\n';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const afterContent = '---\ntitle: Tacos\ntype: recipe\n---\n\n## Ingredients\n- beef\n- cheese\n- salsa\n';
    const llm = makeLLM(afterContent);
    const dq = makeDataQueryService([
      { path: relativePath, appId: 'food', content: '(truncated)' },
    ]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    // Act
    const result = await svc.proposeEdit('Add salsa to the ingredients', 'matt');

    // Assert
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.filePath).toBe(relativePath);
    expect(result.absolutePath).toBe(absolutePath);
    expect(result.appId).toBe('food');
    expect(result.userId).toBe('matt');
    expect(result.beforeContent).toBe(beforeContent);
    expect(result.afterContent).toBe(afterContent);
    expect(result.beforeHash).toBe(sha256(beforeContent));
    expect(result.diff).toContain('+- salsa');
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 100);
  });

  // -------------------------------------------------------------------------
  // Test 2: 0 DataQuery matches → no_match
  // -------------------------------------------------------------------------

  it('proposeEdit: 0 DataQuery matches → kind: error, action: no_match', async () => {
    const dq = makeDataQueryService([]);
    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' }),
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('fix my grocery list', 'matt');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('no_match');
  });

  // -------------------------------------------------------------------------
  // Test 3: >1 DataQuery matches → ambiguous
  // -------------------------------------------------------------------------

  it('proposeEdit: >1 DataQuery matches → kind: error, action: ambiguous', async () => {
    const dq = makeDataQueryService([
      { path: 'users/matt/food/recipes/tacos.yaml', appId: 'food', content: '' },
      { path: 'users/matt/food/recipes/burritos.yaml', appId: 'food', content: '' },
    ]);
    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' }),
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('update my Mexican recipe', 'matt');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('ambiguous');
  });

  // -------------------------------------------------------------------------
  // Test 4: Read-only scope → access_denied
  // -------------------------------------------------------------------------

  it('proposeEdit: read-only scope → kind: error, action: access_denied', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    await writeFile(absolutePath, 'content', 'utf-8');

    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM('new content'),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('fix a typo', 'matt');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('access_denied');
  });

  // -------------------------------------------------------------------------
  // Test 5: Realpath escapes dataDir → access_denied
  // -------------------------------------------------------------------------

  it('proposeEdit: symlink/path escaping dataDir → kind: error, action: access_denied', async () => {
    // Craft a path that resolves outside dataDir via ..
    const maliciousPath = 'users/matt/food/../../../etc/passwd';

    const dq = makeDataQueryService([{ path: maliciousPath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM('new content'),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('edit system file', 'matt');
    // The malicious path would escape dataDir OR not match any scope
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(['access_denied', 'no_match']).toContain(result.action);
  });

  // -------------------------------------------------------------------------
  // Test 6: LLM returns identical content → generation_failed
  // -------------------------------------------------------------------------

  it('proposeEdit: LLM returns identical content → kind: error, action: generation_failed', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const content = 'original content';
    await writeFile(absolutePath, content, 'utf-8');

    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });
    const llm = makeLLM(content); // identical — no change

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('fix nothing', 'matt');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('generation_failed');
    expect(result.message).toMatch(/no changes/i);
  });

  // -------------------------------------------------------------------------
  // Test 7: LLM returns oversized content → generation_failed
  // -------------------------------------------------------------------------

  it('proposeEdit: LLM returns >3x oversized content → kind: error, action: generation_failed', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const before = 'short content';
    await writeFile(absolutePath, before, 'utf-8');

    // 3x + 1 char = oversized
    const oversized = 'x'.repeat(before.length * 3 + 1);
    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });
    const llm = makeLLM(oversized);

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('inflate the file', 'matt');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('generation_failed');
    expect(result.message).toMatch(/too large/i);
  });

  // -------------------------------------------------------------------------
  // Test 8: Confirm with matching hash → ok, file written, events fired
  // -------------------------------------------------------------------------

  it('confirmEdit: matching hash → ok: true, file written, data:changed emitted, logs appended', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const afterContent = 'updated content';
    const eventBus = makeEventBus();
    const changeLog = makeChangeLog();
    const editLog = makeEditLog();
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog,
      eventBus,
      dataDir,
      logger: makeLogger(),
      editLog,
    });

    const proposal = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'fix typo',
      scope: 'user',
      beforeContent,
      afterContent,
      beforeHash: sha256(beforeContent),
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const result = await svc.confirmEdit(proposal);

    expect(result.ok).toBe(true);

    // File should be updated
    const written = await readFile(absolutePath, 'utf-8');
    expect(written).toBe(afterContent);

    // data:changed event emitted
    expect(eventBus.emit).toHaveBeenCalledWith('data:changed', expect.objectContaining({
      path: relativePath,
      appId: 'food',
    }));

    // change log appended
    expect(changeLog.record).toHaveBeenCalled();

    // audit log appended
    expect(editLog.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'confirmed',
      userId: 'matt',
      filePath: relativePath,
      appId: 'food',
    }));
  });

  // -------------------------------------------------------------------------
  // Test 9: Confirm with mismatched hash → stale_rejected
  // -------------------------------------------------------------------------

  it('confirmEdit: mismatched hash → ok: false, reason mentions stale/modified', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });

    // File on disk has been modified since proposal was generated
    const currentContent = 'content modified by another process';
    await writeFile(absolutePath, currentContent, 'utf-8');

    const editLog = makeEditLog();
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog,
    });

    const proposal = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'fix typo',
      scope: 'user',
      beforeContent: 'original content',  // NOT what's on disk
      afterContent: 'updated content',
      beforeHash: sha256('original content'),  // won't match
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const result = await svc.confirmEdit(proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/modified|stale/i);

    // audit log should record stale_rejected
    expect(editLog.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'stale_rejected',
    }));
  });

  // -------------------------------------------------------------------------
  // Test 10: Confirm past expiry → expired
  // -------------------------------------------------------------------------

  it('confirmEdit: expired proposal → ok: false, reason mentions expired', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    await writeFile(absolutePath, 'content', 'utf-8');

    const editLog = makeEditLog();
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog,
    });

    const proposal = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'old edit',
      scope: 'user',
      beforeContent: 'content',
      afterContent: 'new content',
      beforeHash: sha256('content'),
      diff: '...',
      expiresAt: new Date(Date.now() - 1), // already expired
    };

    const result = await svc.confirmEdit(proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/expired/i);

    expect(editLog.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'expired',
    }));
  });

  // -------------------------------------------------------------------------
  // Test 11: Confirm re-checks authorization (revoked access → ok: false)
  // -------------------------------------------------------------------------

  it('confirmEdit: access revoked between propose and confirm → ok: false, access_denied in log', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    // Registry now returns read-only access (access revoked after proposal)
    const revokedRegistry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read' });
    const editLog = makeEditLog();

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      fileIndex: makeFileIndex(),
      appRegistry: revokedRegistry,
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog,
    });

    const proposal = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'edit with revoked access',
      scope: 'user',
      beforeContent,
      afterContent: 'new content',
      beforeHash: sha256(beforeContent),
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const result = await svc.confirmEdit(proposal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/access/i);

    expect(editLog.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'access_denied',
    }));
  });

  // -------------------------------------------------------------------------
  // Test 12: Concurrent confirms — second sees updated hash → stale
  // -------------------------------------------------------------------------

  it('confirmEdit: concurrent confirms — lock serializes, second sees stale hash', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const hash = sha256(beforeContent);
    const proposal1 = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'first edit',
      scope: 'user',
      beforeContent,
      afterContent: 'updated by first',
      beforeHash: hash,
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };
    const proposal2 = {
      ...proposal1,
      afterContent: 'updated by second',
    };

    // Fire both concurrently
    const [r1, r2] = await Promise.all([
      svc.confirmEdit(proposal1),
      svc.confirmEdit(proposal2),
    ]);

    // Exactly one should succeed (first wins lock), the other should see stale hash
    const successes = [r1, r2].filter((r) => r.ok).length;
    const failures = [r1, r2].filter((r) => !r.ok).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    const failResult = [r1, r2].find((r) => !r.ok);
    if (!failResult || failResult.ok) return;
    expect(failResult.reason).toMatch(/modified|stale/i);
  });

  // -------------------------------------------------------------------------
  // Test 13: proposeEdit re-reads full raw file (not DataQuery truncated content)
  // -------------------------------------------------------------------------

  it('proposeEdit: re-reads full raw file, not DataQuery truncated content', async () => {
    const relativePath = 'users/matt/food/recipes/large.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });

    // File is larger than DataQuery's 4000-char limit
    const frontmatter = '---\ntitle: Large Recipe\ntype: recipe\n---\n\n';
    const bodyContent = 'ingredient: ' + 'x'.repeat(5000) + '\n';
    const fullContent = frontmatter + bodyContent;
    expect(fullContent.length).toBeGreaterThan(4000);

    await writeFile(absolutePath, fullContent, 'utf-8');

    // DataQuery returns truncated content (as it would in reality)
    const truncatedContent = fullContent.slice(0, 400) + '... (truncated)';
    const dq = makeDataQueryService([
      { path: relativePath, appId: 'food', content: truncatedContent },
    ]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    // Capture what the LLM receives
    const llmCompleteSpy = vi.fn().mockResolvedValue(fullContent + ' # edited');
    const llm: LLMService = {
      complete: llmCompleteSpy,
      classify: vi.fn(),
      extractStructured: vi.fn(),
    } as unknown as LLMService;

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      fileIndex: makeFileIndex(),
      appRegistry: registry,
      spaceService: makeSpaceService(),
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('add a note', 'matt');

    // The proposal should be generated (LLM was called)
    expect(llmCompleteSpy).toHaveBeenCalled();

    // The LLM prompt should contain the FULL file content, not DataQuery's truncated version
    const promptArg: string = llmCompleteSpy.mock.calls[0][0];
    expect(promptArg).toContain(fullContent);
    expect(promptArg).not.toContain('(truncated)');

    // The proposal should have full beforeContent
    if (result.kind === 'proposal') {
      expect(result.beforeContent).toBe(fullContent);
      expect(result.beforeContent.length).toBeGreaterThan(4000);
    }
  });
});

// ---------------------------------------------------------------------------
// EditLog tests
// ---------------------------------------------------------------------------

describe('EditLog', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(dataDir, 'system'), { recursive: true });
  });

  it('appends JSONL entries to the log file', async () => {
    const logPath = join(dataDir, 'system', 'edit-log.jsonl');
    const log = new EditLog(logPath);

    await log.append({
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'matt',
      filePath: 'users/matt/food/recipes/tacos.yaml',
      appId: 'food',
      outcome: 'confirmed',
      description: 'fix typo',
    });

    await log.append({
      timestamp: '2026-01-01T00:01:00.000Z',
      userId: 'nina',
      filePath: 'users/nina/food/grocery.md',
      appId: 'food',
      outcome: 'cancelled',
    });

    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.userId).toBe('matt');
    expect(entry1.outcome).toBe('confirmed');
    expect(entry1.description).toBe('fix typo');

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.userId).toBe('nina');
    expect(entry2.outcome).toBe('cancelled');
    expect(entry2.description).toBeUndefined();
  });

  it('creates parent directories if they do not exist', async () => {
    const logPath = join(dataDir, 'system', 'subdir', 'edit-log.jsonl');
    const log = new EditLog(logPath);

    await log.append({
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'matt',
      filePath: 'x.md',
      appId: 'food',
      outcome: 'confirmed',
    });

    const content = await readFile(logPath, 'utf-8');
    expect(content).toContain('"outcome":"confirmed"');
  });
});
