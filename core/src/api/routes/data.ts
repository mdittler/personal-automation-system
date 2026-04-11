/**
 * Data ingestion API endpoint.
 *
 * Accepts JSON payloads to write or append data to PAS's scoped data store.
 * Used by external tools (e.g., n8n) to push data into PAS.
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ChangeLog } from '../../services/data-store/change-log.js';
import { DataStoreServiceImpl, SpaceMembershipError } from '../../services/data-store/index.js';
import { PathTraversalError, ScopeViolationError } from '../../services/data-store/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { EventBusService } from '../../types/events.js';
import { SPACE_ID_PATTERN } from '../../types/spaces.js';

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface DataRouteOptions {
	dataDir: string;
	changeLog: ChangeLog;
	spaceService: SpaceService;
	userManager: UserManager;
	eventBus?: EventBusService;
	logger: Logger;
}

interface DataRequestBody {
	userId?: string;
	appId?: string;
	path?: string;
	content?: string;
	mode?: string;
	spaceId?: string;
}

export function registerDataRoute(server: FastifyInstance, options: DataRouteOptions): void {
	const { dataDir, changeLog, spaceService, userManager, eventBus, logger } = options;

	server.post('/data', async (request, reply) => {
		const body = request.body as DataRequestBody | undefined;

		// Validate required fields
		if (!body?.userId) {
			return reply.status(400).send({ ok: false, error: 'Missing required field: userId' });
		}
		if (!body.appId) {
			return reply.status(400).send({ ok: false, error: 'Missing required field: appId' });
		}
		if (!body.path) {
			return reply.status(400).send({ ok: false, error: 'Missing required field: path' });
		}
		if (body.content === undefined || body.content === null || typeof body.content !== 'string') {
			return reply.status(400).send({ ok: false, error: 'Missing required field: content' });
		}

		const { userId, appId, path, content } = body;
		const mode = body.mode ?? 'write';
		const spaceId = body.spaceId;

		// Validate userId format (defense-in-depth — isRegistered also gates this)
		if (!USER_ID_PATTERN.test(userId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid userId format.' });
		}

		// Validate appId format
		if (!APP_ID_PATTERN.test(appId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid appId format.' });
		}

		// Validate mode
		if (mode !== 'write' && mode !== 'append') {
			return reply
				.status(400)
				.send({ ok: false, error: 'Invalid mode. Must be "write" or "append".' });
		}

		// Validate spaceId format if provided
		if (spaceId !== undefined && spaceId !== null) {
			if (!SPACE_ID_PATTERN.test(spaceId)) {
				return reply.status(400).send({ ok: false, error: 'Invalid spaceId format.' });
			}
		}

		// Validate user is registered
		if (!userManager.isRegistered(userId)) {
			return reply.status(403).send({ ok: false, error: 'Unregistered user.' });
		}

		try {
			// Create a DataStore scoped to the requested appId.
			// API is trusted — no manifest scope enforcement needed.
			const dataStore = new DataStoreServiceImpl({
				dataDir,
				appId,
				userScopes: [],
				sharedScopes: [],
				changeLog,
				spaceService,
				eventBus,
			});

			let store: ReturnType<typeof dataStore.forUser>;
			if (spaceId) {
				store = dataStore.forSpace(spaceId, userId);
			} else {
				store = dataStore.forUser(userId);
			}

			if (mode === 'append') {
				await store.append(path, content);
			} else {
				await store.write(path, content);
			}

			logger.info({ userId, appId, path, mode, spaceId }, 'API data write');

			return reply.send({ ok: true, path, mode });
		} catch (err) {
			if (err instanceof SpaceMembershipError) {
				return reply.status(403).send({ ok: false, error: 'Not a member of the requested space.' });
			}
			if (err instanceof PathTraversalError) {
				return reply.status(400).send({ ok: false, error: 'Invalid path: traversal detected.' });
			}
			if (err instanceof ScopeViolationError) {
				return reply.status(403).send({ ok: false, error: 'Path not within declared scopes.' });
			}
			logger.error({ err, userId, appId, path }, 'API data write failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
