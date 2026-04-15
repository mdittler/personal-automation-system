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
import { getCurrentUserId } from '../context/request-context.js';
import type { HouseholdService } from '../household/index.js';
import { UserBoundaryError } from '../household/index.js';
import type { SpaceService } from '../spaces/index.js';
import type { ChangeLog } from './change-log.js';
import { ScopedStore } from './scoped-store.js';
import { SYSTEM_BYPASS_TOKEN } from './system-bypass-token.js';

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
	/** Household service for tenant boundary enforcement (optional). */
	householdService?: HouseholdService;
	/**
	 * Internal: pass SYSTEM_BYPASS_TOKEN to bypass scope enforcement on all returned stores.
	 * For use by internal infrastructure tests only — NOT exposed on DataStoreService interface.
	 */
	_systemBypassToken?: symbol;
}

export class DataStoreServiceImpl implements DataStoreService {
	private readonly dataDir: string;
	private readonly appId: string;
	private readonly userScopes: ManifestDataScope[];
	private readonly sharedScopes: ManifestDataScope[];
	private readonly changeLog: ChangeLog;
	private readonly spaceService?: SpaceService;
	private readonly eventBus?: EventBusService;
	/** Optional — wired in Task J. When absent, legacy path layout is used. */
	private _householdService?: HouseholdService;
	/** Internal test escape hatch: bypass scope enforcement on all returned stores. */
	private readonly _bypassToken?: symbol;

	constructor(options: DataStoreServiceOptions) {
		this.dataDir = options.dataDir;
		this.appId = options.appId;
		this.userScopes = options.userScopes;
		this.sharedScopes = options.sharedScopes;
		this.changeLog = options.changeLog;
		this.spaceService = options.spaceService;
		this.eventBus = options.eventBus;
		this._householdService = options.householdService;
		this._bypassToken = options._systemBypassToken;
	}

	/**
	 * Inject the HouseholdService after construction.
	 * Called by bootstrap wiring (Task J) once HouseholdService is available.
	 */
	setHouseholdService(svc: HouseholdService): void {
		this._householdService = svc;
	}

	forUser(userId: string): UserDataStore {
		// Actor-vs-target check: reject when BOTH actor and target are known and mismatched
		const actorId = getCurrentUserId();
		if (actorId !== undefined && actorId !== userId) {
			throw new UserBoundaryError(actorId, userId);
		}

		// Resolve household-aware path
		const householdId = this._householdService?.getHouseholdForUser(userId) ?? null;
		const baseDir = householdId
			? join(this.dataDir, 'households', householdId, 'users', userId, this.appId)
			: join(this.dataDir, 'users', userId, this.appId);

		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
			scopes: this.userScopes,
			_systemBypassToken: this._bypassToken,
			_eventMeta: {
				householdId,
				spaceKind: null,
				collaborationId: null,
				sharedSelector: null,
			},
		});
	}

	forShared(scope: string): SharedDataStore {
		// Resolve household-aware path from current request context
		const currentUserId = getCurrentUserId();
		const householdId =
			this._householdService && currentUserId
				? this._householdService.getHouseholdForUser(currentUserId)
				: null;

		const baseDir = householdId
			? join(this.dataDir, 'households', householdId, 'shared', this.appId)
			: join(this.dataDir, 'users', 'shared', this.appId);

		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId: null,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
			scopes: this.sharedScopes,
			_systemBypassToken: this._bypassToken,
			_eventMeta: {
				householdId,
				spaceKind: null,
				collaborationId: null,
				sharedSelector: scope,
			},
		});
	}

	forSpace(spaceId: string, userId: string): ScopedDataStore {
		// Actor-vs-target check
		const actorId = getCurrentUserId();
		if (actorId !== undefined && actorId !== userId) {
			throw new UserBoundaryError(actorId, userId);
		}

		// Validate space ID format
		if (!SPACE_ID_PATTERN.test(spaceId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		// Check membership via SpaceService
		if (!this.spaceService?.isMember(spaceId, userId)) {
			throw new SpaceMembershipError(spaceId, userId);
		}

		// Resolve space definition for kind-based routing
		const spaceDef = this.spaceService?.getSpace(spaceId) ?? null;
		const spaceKind = spaceDef?.kind ?? null;

		let baseDir: string;
		let collaborationId: string | null = null;
		let householdId: string | null = null;

		if (spaceKind === 'collaboration') {
			// Collaboration space: cross-household, no household check
			// Assert user is a member (already checked via isMember above)
			baseDir = join(this.dataDir, 'collaborations', spaceId, this.appId);
			collaborationId = spaceId;
		} else if (spaceKind === 'household' && spaceDef?.householdId) {
			// Household space: assert the space's household matches the user's household
			householdId = spaceDef.householdId;
			if (this._householdService) {
				this._householdService.assertUserCanAccessHousehold(userId, householdId);
			}
			baseDir = join(this.dataDir, 'households', householdId, 'spaces', spaceId, this.appId);
		} else {
			// Legacy space (no kind field) or household space without householdId: use old path layout
			baseDir = join(this.dataDir, 'spaces', spaceId, this.appId);
		}

		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId,
			changeLog: this.changeLog,
			spaceId,
			eventBus: this.eventBus,
			scopes: this.sharedScopes,
			_systemBypassToken: this._bypassToken,
			_eventMeta: {
				householdId,
				spaceKind,
				collaborationId,
				sharedSelector: null,
			},
		});
	}

	/**
	 * Get a store rooted at data/system/ with system bypass enabled.
	 * Only accepts the genuine SYSTEM_BYPASS_TOKEN singleton symbol.
	 * NOT on the DataStoreService public interface — apps cannot call this.
	 */
	forSystem(token: symbol): ScopedDataStore {
		if (token !== SYSTEM_BYPASS_TOKEN) {
			throw new Error('Invalid system bypass token');
		}
		const baseDir = join(this.dataDir, 'system');
		return new ScopedStore({
			baseDir,
			appId: this.appId,
			userId: null,
			changeLog: this.changeLog,
			eventBus: this.eventBus,
			scopes: [],
			_systemBypassToken: SYSTEM_BYPASS_TOKEN,
			_eventMeta: {
				householdId: null,
				spaceKind: null,
				collaborationId: null,
				sharedSelector: null,
			},
		});
	}
}

export { ChangeLog } from './change-log.js';
export { PathTraversalError, ScopeViolationError } from './paths.js';
export { HouseholdBoundaryError, UserBoundaryError } from '../household/index.js';
