/**
 * Data store service.
 *
 * Provides scoped data access for apps. Each app receives a DataStoreService
 * bound to its app ID and declared data scopes. The service creates
 * ScopedStore instances for per-user and shared data access.
 *
 * Directory layout:
 *   data/users/<userId>/<appId>/    — per-user app data
 *   data/users/shared/<appId>/      — shared app data
 *   data/system/                    — system data (logs, config, etc.)
 */

import { join } from 'node:path';
import type {
	DataStoreService,
	ScopedDataStore,
	SharedDataStore,
	UserDataStore,
} from '../../types/data-store.js';
import type { EventBusService } from '../../types/events.js';
import type { ManifestDataScope } from '../../types/manifest.js';
import { SPACE_ID_PATTERN } from '../../types/spaces.js';
import type { SpaceService } from '../spaces/index.js';
import type { ChangeLog } from './change-log.js';
import { isWithinDeclaredScopes } from './paths.js';
import { ScopedStore } from './scoped-store.js';

/** Error thrown when a user is not a member of a requested space. */
export class SpaceMembershipError extends Error {
	constructor(
		public readonly spaceId: string,
		public readonly userId: string,
	) {
		super(`User ${userId} is not a member of space "${spaceId}"`);
		this.name = 'SpaceMembershipError';
	}
}

export interface DataStoreServiceOptions {
	/** Absolute path to the data root directory. */
	dataDir: string;
	/** App ID this service is scoped to. */
	appId: string;
	/** Declared user data scopes from the app's manifest. */
	userScopes: ManifestDataScope[];
	/** Declared shared data scopes from the app's manifest. */
	sharedScopes: ManifestDataScope[];
	/** Change log instance (shared across all stores). */
	changeLog: ChangeLog;
	/** Space service for membership checks (optional). */
	spaceService?: SpaceService;
	/** Event bus for emitting data:changed events (optional). */
	eventBus?: EventBusService;
}

export class DataStoreServiceImpl implements DataStoreService {
	private readonly dataDir: string;
	private readonly appId: string;
	private readonly userScopePaths: string[];
	private readonly sharedScopePaths: string[];
	private readonly changeLog: ChangeLog;
	private readonly spaceService?: SpaceService;
	private readonly eventBus?: EventBusService;

	constructor(options: DataStoreServiceOptions) {
		this.dataDir = options.dataDir;
		this.appId = options.appId;
		this.userScopePaths = options.userScopes.map((s) => s.path);
		this.sharedScopePaths = options.sharedScopes.map((s) => s.path);
		this.changeLog = options.changeLog;
		this.spaceService = options.spaceService;
		this.eventBus = options.eventBus;
	}

	forUser(userId: string): UserDataStore {
		const baseDir = join(this.dataDir, 'users', userId, this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
		});
	}

	forShared(_scope: string): SharedDataStore {
		const baseDir = join(this.dataDir, 'users', 'shared', this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId: null,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
		});
	}

	forSpace(spaceId: string, userId: string): ScopedDataStore {
		// Validate space ID format
		if (!SPACE_ID_PATTERN.test(spaceId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		// Check membership via SpaceService
		if (!this.spaceService?.isMember(spaceId, userId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		const baseDir = join(this.dataDir, 'spaces', spaceId, this.appId);
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			spaceId,
			eventBus: this.eventBus,
		});
	}

	/**
	 * Check whether a user-scoped path is within the app's declared scopes.
	 *
	 * NOTE: Scope enforcement is intentionally NOT wired into ScopedStore
	 * operations here. It will be enforced in Phase 5 (bootstrap) when the
	 * infrastructure constructs per-app DataStoreService instances. The
	 * bootstrap layer will validate that apps only access paths declared in
	 * their manifest data scopes, including checking the access level
	 * (read/write/read-write) from ManifestDataScope.
	 */
	isAllowedUserPath(path: string): boolean {
		return isWithinDeclaredScopes(path, this.userScopePaths);
	}

	/**
	 * Check whether a shared-scoped path is within the app's declared scopes.
	 *
	 * See isAllowedUserPath() for enforcement strategy notes.
	 */
	isAllowedSharedPath(path: string): boolean {
		return isWithinDeclaredScopes(path, this.sharedScopePaths);
	}
}

export { ChangeLog } from './change-log.js';
export { PathTraversalError } from './paths.js';
