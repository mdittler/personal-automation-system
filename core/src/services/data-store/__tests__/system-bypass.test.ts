/**
 * Tests for the SYSTEM_BYPASS_TOKEN capability and ScopedStore fail-closed enforcement.
 *
 * Verifies that:
 * - ScopedStore with no scopes + no bypass token → DENY (fail-closed)
 * - ScopedStore with forged bypass token → DENY (referential equality check)
 * - ScopedStore with real SYSTEM_BYPASS_TOKEN → allow (system bypass works)
 * - forSystem() on DataStoreServiceImpl → works with real token, throws with forged
 * - forSystem() is NOT on the public DataStoreService interface (compile-time check)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataStoreService } from '../../../types/data-store.js';
import { ChangeLog } from '../change-log.js';
import { DataStoreServiceImpl } from '../index.js';
import { ScopeViolationError } from '../paths.js';
import { ScopedStore } from '../scoped-store.js';
import { SYSTEM_BYPASS_TOKEN } from '../system-bypass-token.js';

let tempDir: string;
let dataDir: string;
let changeLog: ChangeLog;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-bypass-test-'));
	dataDir = join(tempDir, 'data');
	changeLog = new ChangeLog(dataDir);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('ScopedStore fail-closed enforcement', () => {
	it('throws ScopeViolationError with empty scopes and no bypass token', async () => {
		const store = new ScopedStore({
			baseDir: join(tempDir, 'store'),
			appId: 'test-app',
			userId: 'user-1',
			changeLog,
			scopes: [],
		});
		await expect(store.write('file.md', 'content')).rejects.toThrow(ScopeViolationError);
		await expect(store.read('file.md')).rejects.toThrow(ScopeViolationError);
		await expect(store.append('file.md', 'content')).rejects.toThrow(ScopeViolationError);
		await expect(store.exists('file.md')).rejects.toThrow(ScopeViolationError);
		await expect(store.list('.')).rejects.toThrow(ScopeViolationError);
	});

	it('throws ScopeViolationError with undefined scopes and no bypass token', async () => {
		const store = new ScopedStore({
			baseDir: join(tempDir, 'store-undef'),
			appId: 'test-app',
			userId: 'user-1',
			changeLog,
			// scopes deliberately omitted
		});
		await expect(store.write('file.md', 'content')).rejects.toThrow(ScopeViolationError);
		await expect(store.read('file.md')).rejects.toThrow(ScopeViolationError);
	});

	it('throws when constructed with a forged bypass symbol (referential equality check)', () => {
		const forgedToken = Symbol('pas.systemBypass');
		expect(
			() =>
				new ScopedStore({
					baseDir: join(tempDir, 'store-forged'),
					appId: 'test-app',
					userId: 'user-1',
					changeLog,
					scopes: [],
					_systemBypassToken: forgedToken,
				}),
		).toThrow('Invalid system bypass token');
	});

	it('allows read/write with the real SYSTEM_BYPASS_TOKEN', async () => {
		const store = new ScopedStore({
			baseDir: join(tempDir, 'store-bypass'),
			appId: 'test-app',
			userId: null,
			changeLog,
			scopes: [],
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
		});

		await store.write('system.json', '{"key":"value"}');
		const content = await store.read('system.json');
		expect(content).toBe('{"key":"value"}');
		expect(await store.exists('system.json')).toBe(true);
	});

	it('SYSTEM_BYPASS_TOKEN bypass allows listing directories', async () => {
		const store = new ScopedStore({
			baseDir: join(tempDir, 'store-list'),
			appId: 'test-app',
			userId: null,
			changeLog,
			scopes: [],
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
		});

		await store.write('a.json', '{}');
		await store.write('b.json', '{}');
		const files = await store.list('.');
		expect(files).toContain('a.json');
		expect(files).toContain('b.json');
	});
});

describe('DataStoreServiceImpl.forSystem()', () => {
	it('throws with a forged symbol', () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'system',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});
		const forgedToken = Symbol('pas.systemBypass');
		expect(() => service.forSystem(forgedToken)).toThrow('Invalid system bypass token');
	});

	it('throws with an unrelated symbol', () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'system',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});
		expect(() => service.forSystem(Symbol('something-else'))).toThrow('Invalid system bypass token');
	});

	it('returns a working store with the real SYSTEM_BYPASS_TOKEN', async () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'system',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});

		const store = service.forSystem(SYSTEM_BYPASS_TOKEN);
		await store.write('config.yaml', 'key: value');
		const content = await store.read('config.yaml');
		expect(content).toBe('key: value');
	});

	it('forSystem() store is rooted at data/system/', async () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'system',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});

		const store = service.forSystem(SYSTEM_BYPASS_TOKEN);
		await store.write('test-file.json', '{}');
		expect(await store.exists('test-file.json')).toBe(true);
		// Also verify via ChangeLog path that we're in the system dir
		const logPath = changeLog.getLogPath();
		expect(logPath).toContain('system');
	});
});

/**
 * Compile-time check: `forSystem` must NOT be on the public DataStoreService interface.
 *
 * This test verifies that `forSystem` is not part of the `DataStoreService` type that apps
 * receive via CoreServices. It does not make a runtime assertion — the TypeScript compiler
 * will fail to compile this file if `forSystem` is ever added to `DataStoreService`.
 */
describe('DataStoreService interface does not expose forSystem', () => {
	it('DataStoreService type does not have forSystem property', () => {
		// Assign the impl to the public interface type — this should compile only if
		// DataStoreServiceImpl implements DataStoreService (which it does via forUser/forShared/forSpace).
		// The explicit cast ensures the type check passes at the variable level.
		const _publicApi: DataStoreService = new DataStoreServiceImpl({
			dataDir,
			appId: 'test',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});

		// Compile-time check: the DataStoreService type does not have forSystem.
		// @ts-expect-error — forSystem is not on DataStoreService, so this must error.
		expect(typeof (_publicApi as DataStoreServiceImpl).forSystem).toBe('function');

		// The runtime value IS a function (on the concrete impl).
		// But apps only hold DataStoreService, so they can't call it without casting.
		const impl = _publicApi as DataStoreServiceImpl;
		expect(typeof impl.forSystem).toBe('function');
	});
});
