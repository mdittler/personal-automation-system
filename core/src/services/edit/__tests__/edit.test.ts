/**
 * Tests for EditService — propose/confirm file edits with LLM generation,
 * SHA-256 stale-write protection, per-path locking, and audit logging.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, symlink } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataQueryServiceImpl } from '../../data-query/index.js';
import type { AppRegistry } from '../../app-registry/index.js';
import type { ChangeLog } from '../../data-store/change-log.js';
import type { LLMService } from '../../../types/llm.js';
import type { EventBusService } from '../../../types/events.js';
import type { AppLogger } from '../../../types/app-module.js';
import { EditLog, EditServiceImpl } from '../index.js';
import { requestContext } from '../../context/request-context.js';
import { HouseholdBoundaryError } from '../../household/index.js';

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

function makeLLM(returnValue: string): LLMService {
  return {
    complete: vi.fn().mockResolvedValue(returnValue),
    classify: vi.fn(),
    extractStructured: vi.fn(),
  } as unknown as LLMService;
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
      appRegistry: registry,
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
      appRegistry: makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' }),
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
      appRegistry: makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' }),
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
      appRegistry: registry,
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
  // Test 5: Realpath containment guard — symlink to outside file → access_denied
  // -------------------------------------------------------------------------

  it('proposeEdit: symlink resolves outside dataDir → kind: error, action: access_denied', async () => {
    // Skip on systems that don't support symlinks (or are running as non-admin on Windows)
    // We'll skip silently if symlink creation fails
    const parentDir = await mkdtemp(join(tmpdir(), 'edit-test-parent-'));
    const testDataDir = join(parentDir, 'data');
    await mkdir(testDataDir, { recursive: true });
    await mkdir(join(testDataDir, 'system'), { recursive: true });
    await mkdir(join(testDataDir, 'users/matt/food/recipes'), { recursive: true });

    // Create a file outside dataDir (in parentDir)
    const outsideFilePath = join(parentDir, 'outside.txt');
    await writeFile(outsideFilePath, 'outside content', 'utf-8');

    // Create a symlink inside dataDir that points to the outside file
    const symlinkPath = join(testDataDir, 'users/matt/food/recipes/link-to-outside.txt');
    try {
      // Use junction on Windows, symlink on Unix
      const isWin = platform() === 'win32';
      await symlink(outsideFilePath, symlinkPath, isWin ? 'junction' : 'file');
    } catch (err) {
      // Skip the test if symlinks not supported
      return;
    }

    // The path looks valid (inside data/users/matt/food/recipes/)
    const validPath = 'users/matt/food/recipes/link-to-outside.txt';

    const dq = makeDataQueryService([{ path: validPath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm: makeLLM('new content'),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir: testDataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('edit via symlink', 'matt');
    // realpath follows the symlink and resolves to outside location → containment guard rejects
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.action).toBe('access_denied');
    expect(result.message).toMatch(/escapes the data directory/i);
  });

  // -------------------------------------------------------------------------
  // Test 5b: scope derivation — 'shared' path → scope: 'shared'
  // -------------------------------------------------------------------------

  it('proposeEdit: shared path → EditProposal scope is "shared"', async () => {
    const relativePath = 'users/shared/food/prices/costco.md';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/shared/food/prices'), { recursive: true });
    const beforeContent = '---\ntitle: Costco Prices\n---\n\n## Active\n- Milk: $5\n';
    const afterContent = '---\ntitle: Costco Prices\n---\n\n## Active\n- Milk: $5\n- Eggs: $8\n';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '(truncated)' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'prices/', access: 'read-write', scope: 'shared' });
    const llm = makeLLM(afterContent);

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('Add eggs to Costco prices', 'matt');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.scope).toBe('shared');
    expect(result.spaceId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5c: scope derivation — 'user' path → scope: 'user'
  // -------------------------------------------------------------------------

  it('proposeEdit: user path → EditProposal scope is "user"', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = '---\ntitle: Tacos\n---\n\n## Ingredients\n- beef\n';
    const afterContent = '---\ntitle: Tacos\n---\n\n## Ingredients\n- beef\n- cheese\n';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '(truncated)' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });
    const llm = makeLLM(afterContent);

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('Add cheese to tacos', 'matt');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.scope).toBe('user');
    expect(result.spaceId).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 5d: scope derivation — 'space' path → scope: 'space' with spaceId
  //         (Tests the scope parsing logic from the file path)
  // -------------------------------------------------------------------------

  it('proposeEdit: file at spaces/<spaceId>/... → scope is "space" with extracted spaceId', async () => {
    // This test verifies the scope derivation logic:
    // When a file is at spaces/<spaceId>/app/data, the proposal should have
    // scope: 'space' and spaceId: <spaceId>
    //
    // The test uses a user scope in the manifest (since space_scopes isn't
    // yet in the manifest type), but manually constructs a proposal scenario
    // where the file happens to be under spaces/<spaceId>/...

    const spaceId = 'family-household';
    const relativePath = `spaces/${spaceId}/food/shopping-list.md`;
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, `spaces/${spaceId}/food`), { recursive: true });
    const beforeContent = '---\ntitle: Shopping List\n---\n\n## Active\n- Milk\n';
    const afterContent = '---\ntitle: Shopping List\n---\n\n## Active\n- Milk\n- Eggs\n';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    // Use user scope in manifest so the scope matching succeeds
    // (spaces aren't yet in manifest types, but the derivation logic handles them)
    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '(truncated)' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'shopping-list.md', access: 'read-write' });
    const llm = makeLLM(afterContent);

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('Add eggs to the list', 'matt');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    expect(result.scope).toBe('space');
    expect(result.spaceId).toBe(spaceId);
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
      appRegistry: registry,
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
      appRegistry: registry,
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
  // Test 7b: LLM output with only a leading code fence is NOT stripped (Bug 3 fix)
  // Only strip when BOTH leading and trailing fences are present (LLM wrapper pattern)
  // -------------------------------------------------------------------------

  it('proposeEdit: LLM output with only a leading code fence is preserved as-is', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    // LLM returns content with a leading code fence but NO trailing fence.
    // This could be legitimate markdown starting with a code block.
    // The stripping logic must NOT remove the leading fence unless both are present.
    const llmOutput = '```yaml\nupdated content';  // leading fence only
    const llm = makeLLM(llmOutput);
    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('update content', 'matt');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    // The leading fence must NOT have been stripped (only trailing-less fences should not be stripped)
    expect(result.afterContent).toBe(llmOutput);
    expect(result.afterContent).toContain('```yaml');
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
      appRegistry: registry,
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

    // data:changed event emitted with correct ScopedStore-style payload
    expect(eventBus.emit).toHaveBeenCalledWith('data:changed', expect.objectContaining({
      operation: 'write',
      path: 'recipes/tacos.yaml', // app-relative (strips users/<userId>/food/)
      appId: 'food',
      userId: 'matt',
    }));

    // change log appended with app-relative path (Bug 2 fix: not full data-root-relative path)
    expect(changeLog.record).toHaveBeenCalledWith('write', 'recipes/tacos.yaml', 'food', 'matt', undefined);

    // audit log appended
    expect(editLog.append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'confirmed',
      userId: 'matt',
      filePath: relativePath,
      appId: 'food',
    }));
  });

  // -------------------------------------------------------------------------
  // Test 8b: confirmEdit on a shared-scoped file passes null userId to changeLog
  // -------------------------------------------------------------------------

  it('confirmEdit: shared-scoped edit passes null userId to changeLog.record', async () => {
    const relativePath = 'users/shared/food/prices/costco.md';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/shared/food/prices'), { recursive: true });
    const beforeContent = '# Costco\n- Milk: $5\n';
    const afterContent = '# Costco\n- Milk: $5\n- Eggs: $8\n';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const changeLog = makeChangeLog();
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'prices/', access: 'read-write', scope: 'shared' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      appRegistry: registry,
      llm: makeLLM(''),
      changeLog,
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const proposal = {
      kind: 'proposal' as const,
      proposalId: 'test-shared-id',
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',        // the requesting user
      description: 'add eggs',
      scope: 'shared',       // shared scope → changeLog.record userId must be null
      beforeContent,
      afterContent,
      beforeHash: sha256(beforeContent),
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const result = await svc.confirmEdit(proposal);
    expect(result.ok).toBe(true);

    // Shared scope → userId must be null in changeLog to match ScopedStore.forShared() convention
    expect(changeLog.record).toHaveBeenCalledWith('write', 'prices/costco.md', 'food', null, undefined);
  });

  // -------------------------------------------------------------------------
  // Test 7c: code fence stripping is skipped when beforeContent was already fence-wrapped
  // -------------------------------------------------------------------------

  it('proposeEdit: does NOT strip fences when beforeContent was already fence-wrapped', async () => {
    // A file whose actual content is a single fenced code block (e.g. a code snippet file).
    // The LLM correctly returns the updated content still wrapped in fences.
    // Stripping would corrupt it — we must NOT strip when beforeContent had the same fence structure.
    const relativePath = 'users/matt/food/recipes/snippet.md';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });

    // beforeContent is legitimately fence-wrapped
    const beforeContent = '```python\nprint("hello")\n```';
    const afterContent  = '```python\nprint("hello world")\n```';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const llm = makeLLM(afterContent);
    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const result = await svc.proposeEdit('update the print statement', 'matt');
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    // Fences must be preserved — the LLM returned correct content, not a wrapper
    expect(result.afterContent).toBe(afterContent);
    expect(result.afterContent).toMatch(/^```python/);
    expect(result.afterContent).toMatch(/```$/);
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
      appRegistry: registry,
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
      appRegistry: registry,
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
      appRegistry: revokedRegistry,
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
      appRegistry: registry,
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
      appRegistry: registry,
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

  // -------------------------------------------------------------------------
  // Test 14: proposeEdit returns a unique proposalId per call (Bug 1 fix)
  // Two proposals on the same unchanged file share beforeHash but differ in proposalId
  // -------------------------------------------------------------------------

  it('proposeEdit: two proposals to the same unchanged file have different proposalIds', async () => {
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(absolutePath, beforeContent, 'utf-8');

    const afterContent = 'updated content';
    const dq = makeDataQueryService([{ path: relativePath, appId: 'food', content: '' }]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });
    const llm = makeLLM(afterContent);

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm,
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const r1 = await svc.proposeEdit('edit 1', 'matt');
    const r2 = await svc.proposeEdit('edit 2', 'matt');

    expect(r1.kind).toBe('proposal');
    expect(r2.kind).toBe('proposal');
    if (r1.kind !== 'proposal' || r2.kind !== 'proposal') return;

    // Both share the same beforeHash (file unchanged)
    expect(r1.beforeHash).toBe(r2.beforeHash);

    // But proposalId must be unique to distinguish them
    expect(r1.proposalId).toBeDefined();
    expect(r2.proposalId).toBeDefined();
    expect(r1.proposalId).not.toBe(r2.proposalId);
  });

  // -------------------------------------------------------------------------
  // Test 15: confirmEdit uses filePath to derive the write path, not absolutePath (Bug 2 fix)
  // A proposal with a mismatched absolutePath (pointing to a different file inside dataDir)
  // must write to the file at filePath, not at the stored absolutePath.
  // -------------------------------------------------------------------------

  it('confirmEdit: writes to file at filePath, not at the stored absolutePath', async () => {
    const authorizedRelPath = 'users/matt/food/recipes/tacos.yaml';
    const decoyRelPath = 'users/matt/food/recipes/decoy.yaml';
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });

    const beforeContent = 'original tacos';
    const afterContent = 'updated tacos';
    // Write the authorized file
    await writeFile(join(dataDir, authorizedRelPath), beforeContent, 'utf-8');
    // Write the decoy file (the stored absolutePath will point here)
    await writeFile(join(dataDir, decoyRelPath), beforeContent, 'utf-8');

    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      appRegistry: registry,
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    // Construct a forged proposal: filePath points to tacos.yaml (authorized)
    // but absolutePath points to decoy.yaml (a different file, also in dataDir)
    const proposal = {
      kind: 'proposal' as const,
      filePath: authorizedRelPath,
      absolutePath: join(dataDir, decoyRelPath), // mismatched!
      proposalId: 'test-proposal-id',
      appId: 'food',
      userId: 'matt',
      description: 'update tacos',
      scope: 'user',
      beforeContent,
      afterContent,
      beforeHash: sha256(beforeContent),
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const result = await svc.confirmEdit(proposal);
    expect(result.ok).toBe(true);

    // The file at filePath should be updated
    const tacosContent = await readFile(join(dataDir, authorizedRelPath), 'utf-8');
    expect(tacosContent).toBe(afterContent);

    // The decoy file must NOT be changed
    const decoyContent = await readFile(join(dataDir, decoyRelPath), 'utf-8');
    expect(decoyContent).toBe(beforeContent);
  });

  // -------------------------------------------------------------------------
  // Household boundary tests
  // -------------------------------------------------------------------------

  it('proposeEdit: householdId in context, dataDir is under a different household → throws HouseholdBoundaryError', async () => {
    // dataDir is under households/hh-beta/ — the absolute path will contain /households/hh-beta/
    // but the context says hh-alpha → boundary violation
    const hhBetaDataDir = join(dataDir, 'households', 'hh-beta');
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    await mkdir(join(hhBetaDataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(join(hhBetaDataDir, relativePath), beforeContent, 'utf-8');

    const afterContent = 'updated content';
    const dq = makeDataQueryService([
      { path: relativePath, appId: 'food', content: '(truncated)' },
    ]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm: makeLLM(afterContent),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir: hhBetaDataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    // Run with context householdId 'hh-alpha' — absolute path contains hh-beta → violation
    await expect(
      requestContext.run({ userId: 'matt', householdId: 'hh-alpha' }, () =>
        svc.proposeEdit('change something', 'matt'),
      ),
    ).rejects.toThrow(HouseholdBoundaryError);
  });

  it('proposeEdit: householdId in context matches path household → succeeds', async () => {
    // dataDir is under households/hh-alpha/ — absolute path contains /households/hh-alpha/
    const hhAlphaDataDir = join(dataDir, 'households', 'hh-alpha');
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    await mkdir(join(hhAlphaDataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(join(hhAlphaDataDir, relativePath), beforeContent, 'utf-8');

    const afterContent = 'updated content';
    const dq = makeDataQueryService([
      { path: relativePath, appId: 'food', content: '(truncated)' },
    ]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm: makeLLM(afterContent),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir: hhAlphaDataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    // householdId matches hh-alpha in the absolute path → should succeed
    const result = await requestContext.run({ userId: 'matt', householdId: 'hh-alpha' }, () =>
      svc.proposeEdit('change something', 'matt'),
    );

    expect(result.kind).toBe('proposal');
  });

  it('proposeEdit: no householdId in context → fail-open, any path succeeds', async () => {
    // dataDir is under households/hh-beta/ but no householdId in context → should be allowed
    const hhBetaDataDir = join(dataDir, 'households', 'hh-beta');
    const relativePath = 'users/matt/food/recipes/tacos.yaml';
    await mkdir(join(hhBetaDataDir, 'users/matt/food/recipes'), { recursive: true });
    const beforeContent = 'original content';
    await writeFile(join(hhBetaDataDir, relativePath), beforeContent, 'utf-8');

    const afterContent = 'updated content';
    const dq = makeDataQueryService([
      { path: relativePath, appId: 'food', content: '(truncated)' },
    ]);
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });

    const svc = new EditServiceImpl({
      dataQueryService: dq,
      appRegistry: registry,
      llm: makeLLM(afterContent),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir: hhBetaDataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    // No requestContext.run → no householdId in context → fail-open
    const result = await svc.proposeEdit('change something', 'matt');

    expect(result.kind).toBe('proposal');
  });
});

// ---------------------------------------------------------------------------
// withFileLock integration — sequential confirms
// ---------------------------------------------------------------------------

describe('withFileLock integration — sequential confirms', () => {
  it('cleans up the lock Map after sequential acquisitions on the same path', async () => {
    // confirms on the same path are serialized via the shared FileMutex
    const relativePath = 'users/matt/food/recipes/lock-test.yaml';
    let dataDir: string;
    dataDir = makeTmpDir();
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(dataDir, 'system'), { recursive: true });

    const absolutePath = join(dataDir, relativePath);
    await mkdir(join(dataDir, 'users/matt/food/recipes'), { recursive: true });

    // First confirm: write v1 → v2
    await writeFile(absolutePath, 'v1', 'utf-8');
    const registry = makeAppRegistry({ appId: 'food', scopePath: 'recipes/', access: 'read-write' });
    const svc = new EditServiceImpl({
      dataQueryService: makeDataQueryService([]),
      appRegistry: registry,
      llm: makeLLM(''),
      changeLog: makeChangeLog(),
      eventBus: makeEventBus(),
      dataDir,
      logger: makeLogger(),
      editLog: makeEditLog(),
    });

    const proposal1 = {
      kind: 'proposal' as const,
      filePath: relativePath,
      absolutePath,
      appId: 'food',
      userId: 'matt',
      description: 'first sequential edit',
      scope: 'user',
      beforeContent: 'v1',
      afterContent: 'v2',
      beforeHash: sha256('v1'),
      diff: '...',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    };

    const r1 = await svc.confirmEdit(proposal1);
    expect(r1.ok).toBe(true);

    // Second confirm: write v2 → v3
    await writeFile(absolutePath, 'v2', 'utf-8');
    const proposal2 = {
      ...proposal1,
      description: 'second sequential edit',
      beforeContent: 'v2',
      afterContent: 'v3',
      beforeHash: sha256('v2'),
    };

    const r2 = await svc.confirmEdit(proposal2);
    expect(r2.ok).toBe(true);

    // Both confirms succeeded — file should be at v3
    const written = await readFile(absolutePath, 'utf-8');
    expect(written).toBe('v3');
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
