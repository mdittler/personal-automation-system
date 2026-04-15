/**
 * Data read API endpoint.
 *
 * Returns file contents or directory listings from PAS's scoped data store.
 * Used by external tools (e.g., n8n) to read data from PAS.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { PathTraversalError, resolveScopedPath } from '../../services/data-store/paths.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { SPACE_ID_PATTERN } from '../../types/spaces.js';

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Maximum file size to read (1MB). */
const MAX_FILE_SIZE = 1024 * 1024;

export interface DataReadRouteOptions {
	dataDir: string;
	spaceService: SpaceService;
	userManager: UserManager;
	logger: Logger;
	/**
	 * Optional — when present, user reads route to households/<hh>/users/<u>/<app>/
	 * and space reads route based on space kind (household or collaboration).
	 * This is NOT authentication — the route is a privileged shared-admin API.
	 * Per-user API auth is deferred to D5b.
	 */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
}

/**
 * Resolve the base directory for a read request, accounting for household routing.
 * Private to this module — do not expose on any public interface.
 */
function resolveApiReadBaseDir(opts: {
	dataDir: string;
	appId: string;
	userId: string;
	spaceId?: string;
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	spaceService: SpaceService;
}): string {
	if (opts.spaceId) {
		const spaceDef = opts.spaceService.getSpace(opts.spaceId) ?? null;
		if (spaceDef?.kind === 'household' && spaceDef.householdId) {
			return join(
				opts.dataDir,
				'households',
				spaceDef.householdId,
				'spaces',
				opts.spaceId,
				opts.appId,
			);
		}
		if (spaceDef?.kind === 'collaboration') {
			return join(opts.dataDir, 'collaborations', opts.spaceId, opts.appId);
		}
		// Legacy / unknown kind — transitional fallback
		return join(opts.dataDir, 'spaces', opts.spaceId, opts.appId);
	}
	const hhId = opts.householdService?.getHouseholdForUser(opts.userId) ?? null;
	if (hhId) {
		return join(opts.dataDir, 'households', hhId, 'users', opts.userId, opts.appId);
	}
	return join(opts.dataDir, 'users', opts.userId, opts.appId);
}

interface DataReadQuery {
	userId?: string;
	appId?: string;
	path?: string;
	spaceId?: string;
}

export function registerDataReadRoute(
	server: FastifyInstance,
	options: DataReadRouteOptions,
): void {
	const { dataDir, spaceService, userManager, logger, householdService } = options;

	server.get('/data', async (request, reply) => {
		const query = request.query as DataReadQuery;

		// Validate required fields
		if (!query.userId) {
			return reply.status(400).send({ ok: false, error: 'Missing required parameter: userId' });
		}
		if (!query.appId) {
			return reply.status(400).send({ ok: false, error: 'Missing required parameter: appId' });
		}
		if (!query.path) {
			return reply.status(400).send({ ok: false, error: 'Missing required parameter: path' });
		}

		const { userId, appId, path, spaceId } = query;

		// Validate userId format
		if (!USER_ID_PATTERN.test(userId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid userId format.' });
		}

		// Validate appId format
		if (!APP_ID_PATTERN.test(appId)) {
			return reply.status(400).send({ ok: false, error: 'Invalid appId format.' });
		}

		// Validate spaceId format if provided
		if (spaceId !== undefined && spaceId !== '') {
			if (!SPACE_ID_PATTERN.test(spaceId)) {
				return reply.status(400).send({ ok: false, error: 'Invalid spaceId format.' });
			}
		}

		// Validate user is registered
		if (!userManager.isRegistered(userId)) {
			return reply.status(403).send({ ok: false, error: 'Unregistered user.' });
		}

		try {
			// Validate space membership before resolving path
			if (spaceId && !spaceService.isMember(spaceId, userId)) {
				return reply
					.status(403)
					.send({ ok: false, error: 'Not a member of the requested space.' });
			}

			// Resolve the base directory — household-aware when householdService is wired
			const baseDir = resolveApiReadBaseDir({
				dataDir,
				appId,
				userId,
				spaceId,
				householdService,
				spaceService,
			});

			// Resolve and validate path (throws on traversal)
			const fullPath = resolveScopedPath(baseDir, path);

			// Check what's at the path
			let pathStat: Awaited<ReturnType<typeof stat>> | undefined;
			try {
				pathStat = await stat(fullPath);
			} catch {
				// Path doesn't exist
				return reply.send({ ok: true, type: 'not_found', path });
			}

			if (pathStat.isDirectory()) {
				// Directory listing
				const entries = await readdir(fullPath, { withFileTypes: true });
				const listing = entries
					.map((entry) => ({
						name: entry.name,
						isDirectory: entry.isDirectory(),
					}))
					.sort((a, b) => a.name.localeCompare(b.name));

				logger.info({ userId, appId, path, spaceId, type: 'directory' }, 'API data read');
				return reply.send({ ok: true, type: 'directory', path, entries: listing });
			}

			if (pathStat.isFile()) {
				// Check file size
				if (pathStat.size > MAX_FILE_SIZE) {
					return reply.status(413).send({
						ok: false,
						error: `File exceeds maximum size of ${MAX_FILE_SIZE} bytes.`,
					});
				}

				const content = await readFile(fullPath, 'utf-8');
				logger.info({ userId, appId, path, spaceId, type: 'file' }, 'API data read');
				return reply.send({ ok: true, type: 'file', path, content });
			}

			// Neither file nor directory
			return reply.send({ ok: true, type: 'not_found', path });
		} catch (err) {
			if (err instanceof PathTraversalError) {
				return reply.status(400).send({ ok: false, error: 'Invalid path: traversal detected.' });
			}
			logger.error({ err, userId, appId, path }, 'API data read failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
