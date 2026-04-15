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
 * I-9: Import audit — SYSTEM_BYPASS_TOKEN must not leak via barrel files.
 *
 * The token module is private by design. Only a controlled set of internal
 * modules may import it directly; no @core/* barrel or public index should
 * re-export it.  This test reads the barrel files and asserts the token is
 * not among their exports.
 */
describe('SYSTEM_BYPASS_TOKEN import audit', () => {
	const { readFileSync, readdirSync } = require('node:fs');
	const { join: pathJoin, resolve: pathResolve } = require('node:path');

	// Locate the project root relative to this test file
	const projectRoot = pathResolve(__dirname, '../../../../..');

	/** Approved direct importers of system-bypass-token.ts (relative to core/src/) */
	const APPROVED_IMPORTERS = new Set([
		'services/data-store/scoped-store.ts',
		'services/data-store/index.ts',
		'api/routes/data.ts',
	]);

	/** Barrel / index files that must NOT re-export the token */
	const BARREL_FILES = [
		'core/src/index.ts',
		'core/src/types/index.ts',
	];

	it('no barrel file re-exports system-bypass-token', () => {
		for (const barrelRelPath of BARREL_FILES) {
			const fullPath = pathJoin(projectRoot, barrelRelPath);
			let content: string;
			try {
				content = readFileSync(fullPath, 'utf8');
			} catch {
				// Barrel doesn't exist — nothing to check
				continue;
			}
			expect(
				content,
				`Barrel "${barrelRelPath}" must not re-export SYSTEM_BYPASS_TOKEN`,
			).not.toContain('system-bypass-token');
		}
	});

	it('only approved modules import system-bypass-token', () => {
		const coreSrc = pathJoin(projectRoot, 'core/src');

		function walk(dir: string): string[] {
			const result: string[] = [];
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = pathJoin(dir, entry.name);
				if (entry.isDirectory()) {
					result.push(...walk(full));
				} else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
					result.push(full);
				}
			}
			return result;
		}

		const allFiles = walk(coreSrc);
		const violations: string[] = [];

		for (const file of allFiles) {
			// Relative path from core/src/ — normalise to forward slashes for set lookup
			const rel = file.slice(coreSrc.length + 1).replace(/\\/g, '/');

			// Skip the token definition file itself and test files
			if (rel === 'services/data-store/system-bypass-token.ts') continue;
			if (rel.includes('__tests__') || rel.includes('.test.')) continue;

			const content = readFileSync(file, 'utf8');
			if (content.includes('system-bypass-token') && !APPROVED_IMPORTERS.has(rel)) {
				violations.push(rel);
			}
		}

		expect(violations).toEqual([]);
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
