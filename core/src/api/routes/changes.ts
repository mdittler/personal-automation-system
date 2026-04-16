/**
 * Change log read API endpoint.
 *
 * Returns change log entries filtered by time window and optional app filter.
 * - GET /changes?since=ISO&appFilter=notes&limit=100
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { collectChanges } from '../../services/daily-diff/collector.js';
import type { ChangeLog } from '../../services/data-store/change-log.js';
import { getCurrentHouseholdId } from '../../services/context/request-context.js';
import type { ChangeLogEntry } from '../../types/data-store.js';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

export interface ChangesRouteOptions {
	changeLog: ChangeLog;
	logger: Logger;
}

interface ChangesQuery {
	since?: string;
	appFilter?: string;
	limit?: string;
}

export function registerChangesRoute(server: FastifyInstance, options: ChangesRouteOptions): void {
	const { changeLog, logger } = options;

	server.get('/changes', async (request, reply) => {
		// D5b-7: defensive fail-closed — the auth hook always sets request.actor, but
		// guard here in case of misconfiguration so the route never fails open.
		if (!request.actor) {
			return reply.status(401).send({ ok: false, error: 'Unauthenticated.' });
		}

		const query = request.query as ChangesQuery;

		// Parse 'since' — default to last 24 hours
		let since: Date;
		if (query.since) {
			since = new Date(query.since);
			if (Number.isNaN(since.getTime())) {
				return reply
					.status(400)
					.send({ ok: false, error: 'Invalid "since" date format. Use ISO 8601.' });
			}
		} else {
			since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		}

		// Parse limit
		let limit = DEFAULT_LIMIT;
		if (query.limit) {
			limit = Number.parseInt(query.limit, 10);
			if (Number.isNaN(limit) || limit < 1) {
				return reply.status(400).send({ ok: false, error: 'Invalid "limit" value.' });
			}
			limit = Math.min(limit, MAX_LIMIT);
		}

		try {
			const changes = await collectChanges(changeLog.getLogPath(), since);

			let entries: ChangeLogEntry[] = changes.entries;

			// Household boundary filter: if the request context carries a householdId,
			// only return entries whose householdId matches (or that have no householdId —
			// system/collaboration changes are visible to all). Fail-open when no
			// householdId in context (system caller or pre-migration instance).
			const requestHouseholdId = getCurrentHouseholdId();
			if (requestHouseholdId) {
				entries = entries.filter(
					(e) => !e.householdId || e.householdId === requestHouseholdId,
				);
			}

			// Optional app filter
			if (query.appFilter) {
				entries = entries.filter((e) => e.appId === query.appFilter);
			}

			// Apply limit
			entries = entries.slice(0, limit);

			logger.info(
				{
					since: since.toISOString(),
					appFilter: query.appFilter,
					requestHouseholdId,
					count: entries.length,
				},
				'API changes listed',
			);

			return reply.send({
				ok: true,
				since: since.toISOString(),
				count: entries.length,
				entries,
			});
		} catch (err) {
			logger.error({ err }, 'API changes list failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
