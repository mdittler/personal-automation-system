import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceService } from '../../spaces/index.js';
import { ChangeLog } from '../change-log.js';
import { DataStoreServiceImpl, SpaceMembershipError } from '../index.js';
import { PathTraversalError, ScopeViolationError } from '../paths.js';

let tempDir: string;
let dataDir: string;
let changeLog: ChangeLog;

const mockSpaceService = {
	isMember: vi.fn(),
} as unknown as SpaceService;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-spaces-test-'));
	dataDir = join(tempDir, 'data');
	changeLog = new ChangeLog(dataDir);
	vi.clearAllMocks();
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('DataStoreServiceImpl.forSpace()', () => {
	describe('path resolution', () => {
		it('returns ScopedStore rooted at data/spaces/<spaceId>/<appId>/', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'grocery',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('family', 'user-1');
			await store.write('list.md', '- Milk\n- Eggs');

			const fullPath = join(dataDir, 'spaces', 'family', 'grocery', 'list.md');
			const content = await readFile(fullPath, 'utf-8');
			expect(content).toBe('- Milk\n- Eggs');
		});

		it('can read files written to the space directory', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('project-x', 'user-1');
			await store.write('readme.md', 'Hello from space');
			const content = await store.read('readme.md');
			expect(content).toBe('Hello from space');
		});

		it('can append to files in the space directory', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('team', 'user-1');
			await store.write('log.md', 'line1\n');
			await store.append('log.md', 'line2\n');
			const content = await store.read('log.md');
			expect(content).toBe('line1\nline2\n');
		});

		it('path traversal protection works for space stores', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('team', 'user-1');
			await expect(store.read('../../etc/passwd')).rejects.toThrow(PathTraversalError);
			await expect(store.write('../escape.md', 'bad')).rejects.toThrow(PathTraversalError);
			await expect(store.append('../../bad.md', 'bad')).rejects.toThrow(PathTraversalError);
		});

		it('supports nested paths within space store', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('team', 'user-1');
			await store.write('sub/dir/deep.md', 'nested content');
			const content = await store.read('sub/dir/deep.md');
			expect(content).toBe('nested content');
		});
	});

	describe('membership enforcement', () => {
		it('throws SpaceMembershipError when user is not a member', () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(false);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			expect(() => service.forSpace('secret-club', 'outsider')).toThrow(SpaceMembershipError);
			expect(() => service.forSpace('secret-club', 'outsider')).toThrow(
				'User outsider is not a member of space "secret-club"',
			);
		});

		it('throws SpaceMembershipError when spaceId has invalid format', () => {
			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			// Starts with number
			expect(() => service.forSpace('1invalid', 'user-1')).toThrow(SpaceMembershipError);
			// Contains uppercase
			expect(() => service.forSpace('Invalid', 'user-1')).toThrow(SpaceMembershipError);
			// Contains special chars
			expect(() => service.forSpace('space_name', 'user-1')).toThrow(SpaceMembershipError);

			// isMember should not be called for invalid format
			expect(mockSpaceService.isMember).not.toHaveBeenCalled();
		});

		it('throws SpaceMembershipError when spaceService is not provided', () => {
			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				// no spaceService
			});

			expect(() => service.forSpace('team', 'user-1')).toThrow(SpaceMembershipError);
		});

		it('works when user IS a member', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const store = service.forSpace('team', 'user-1');
			// Should not throw; store should be usable
			await store.write('test.md', 'allowed');
			const content = await store.read('test.md');
			expect(content).toBe('allowed');
			expect(mockSpaceService.isMember).toHaveBeenCalledWith('team', 'user-1');
		});
	});

	describe('edge cases', () => {
		it('throws SpaceMembershipError for empty string spaceId', () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			expect(() => service.forSpace('', 'user-1')).toThrow(SpaceMembershipError);
		});

		it('throws SpaceMembershipError for path traversal in spaceId', () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			expect(() => service.forSpace('../evil', 'user-1')).toThrow(SpaceMembershipError);
			expect(() => service.forSpace('..\\evil', 'user-1')).toThrow(SpaceMembershipError);
			// isMember should not be called for invalid format
			expect(mockSpaceService.isMember).not.toHaveBeenCalled();
		});

		it('different space IDs produce isolated stores', async () => {
			vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

			const service = new DataStoreServiceImpl({
				dataDir,
				appId: 'notes',
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService: mockSpaceService,
			});

			const storeA = service.forSpace('space-a', 'user-1');
			const storeB = service.forSpace('space-b', 'user-1');

			await storeA.write('file.md', 'from A');
			await storeB.write('file.md', 'from B');

			expect(await storeA.read('file.md')).toBe('from A');
			expect(await storeB.read('file.md')).toBe('from B');
		});
	});
});

describe('ChangeLog with spaceId', () => {
	it('includes spaceId in log entry when provided', async () => {
		await changeLog.record('write', 'file.md', 'notes', 'user-1', 'family');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entry = JSON.parse(logContent.trim());
		expect(entry.spaceId).toBe('family');
		expect(entry.appId).toBe('notes');
		expect(entry.userId).toBe('user-1');
		expect(entry.operation).toBe('write');
	});

	it('omits spaceId when not provided (backward compat)', async () => {
		await changeLog.record('write', 'file.md', 'notes', 'user-1');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entry = JSON.parse(logContent.trim());
		expect(entry.spaceId).toBeUndefined();
		expect(entry.appId).toBe('notes');
	});

	it('omits spaceId when explicitly passed as undefined', async () => {
		await changeLog.record('write', 'file.md', 'notes', 'user-1', undefined);

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entry = JSON.parse(logContent.trim());
		expect(entry.spaceId).toBeUndefined();
	});
});

describe('ScopedStore passes spaceId to change log', () => {
	it('write operation includes spaceId in change log', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'grocery',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			spaceService: mockSpaceService,
		});

		const store = service.forSpace('family', 'user-1');
		await store.write('list.md', '- Milk');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entries = logContent
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const writeEntry = entries.find((e) => e.operation === 'write');
		expect(writeEntry).toBeDefined();
		expect(writeEntry.spaceId).toBe('family');
		expect(writeEntry.appId).toBe('grocery');
	});

	it('append operation includes spaceId in change log', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'grocery',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			spaceService: mockSpaceService,
		});

		const store = service.forSpace('family', 'user-1');
		await store.append('log.md', 'entry\n');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entries = logContent
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const appendEntry = entries.find((e) => e.operation === 'append');
		expect(appendEntry).toBeDefined();
		expect(appendEntry.spaceId).toBe('family');
	});

	it('read operation includes spaceId in change log', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'grocery',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			spaceService: mockSpaceService,
		});

		const store = service.forSpace('family', 'user-1');
		// Write first so read has a file to find
		await store.write('list.md', '- Milk');
		const content = await store.read('list.md');
		expect(content).toBe('- Milk');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entries = logContent
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const readEntry = entries.find((e) => e.operation === 'read');
		expect(readEntry).toBeDefined();
		expect(readEntry.spaceId).toBe('family');
	});

	it('archive operation includes spaceId in change log', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'grocery',
			userScopes: [],
			sharedScopes: [],
			changeLog,
			spaceService: mockSpaceService,
		});

		const store = service.forSpace('family', 'user-1');
		await store.write('list.md', '- Milk');
		await store.archive('list.md');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entries = logContent
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const archiveEntry = entries.find((e) => e.operation === 'archive');
		expect(archiveEntry).toBeDefined();
		expect(archiveEntry.spaceId).toBe('family');
	});

	it('non-space store omits spaceId from change log entries', async () => {
		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'notes',
			userScopes: [],
			sharedScopes: [],
			changeLog,
		});

		const userStore = service.forUser('user-1');
		await userStore.write('test.md', 'content');

		const logContent = await readFile(changeLog.getLogPath(), 'utf-8');
		const entry = JSON.parse(logContent.trim());
		expect(entry.spaceId).toBeUndefined();
		expect(entry.appId).toBe('notes');
		expect(entry.userId).toBe('user-1');
	});
});

describe('forSpace() scope enforcement', () => {
	it('throws ScopeViolationError when writing outside sharedScopes', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'notes',
			userScopes: [],
			sharedScopes: [{ path: 'allowed/', access: 'read-write', description: '' }],
			changeLog,
			spaceService: mockSpaceService,
		});
		const spaceStore = service.forSpace('family', 'user-1');
		await expect(spaceStore.write('forbidden.md', 'x')).rejects.toThrow(ScopeViolationError);
	});

	it('permits write within sharedScopes for forSpace()', async () => {
		vi.mocked(mockSpaceService.isMember).mockReturnValue(true);

		const service = new DataStoreServiceImpl({
			dataDir,
			appId: 'notes',
			userScopes: [],
			sharedScopes: [{ path: 'allowed/', access: 'read-write', description: '' }],
			changeLog,
			spaceService: mockSpaceService,
		});
		const spaceStore = service.forSpace('family', 'user-1');
		await expect(spaceStore.write('allowed/note.md', 'x')).resolves.toBeUndefined();
	});
});
