/**
 * Alert API endpoints.
 *
 * Exposes alert CRUD and evaluation for external orchestration (n8n).
 * - GET  /alerts            — list all alert definitions
 * - GET  /alerts/:id        — get a single alert definition
 * - POST /alerts/:id/evaluate — evaluate condition, execute actions if met
 * - POST /alerts/:id/fire   — evaluate and fire (alias for evaluate without preview)
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { requireScope } from '../guards/require-scope.js';
import type { AlertService } from '../../services/alerts/index.js';
import type { AuthenticatedActor } from '../../types/auth-actor.js';
import { ALERT_ID_PATTERN } from '../../types/alert.js';

/** Returns true when the actor can see the alert (is in its delivery list). Admin/system bypass. */
function isDeliveryVisible(actor: AuthenticatedActor, delivery: string[]): boolean {
	if (actor.isPlatformAdmin || actor.authMethod === 'legacy-api-token') return true;
	return delivery.includes(actor.userId);
}

/** Returns true when the actor is allowed to evaluate/fire alerts. */
function canRunAlerts(actor: AuthenticatedActor): boolean {
	return actor.isPlatformAdmin || actor.authMethod === 'legacy-api-token';
}

export interface AlertsApiRouteOptions {
	alertService: AlertService;
	logger: Logger;
}

export function registerAlertsApiRoute(
	server: FastifyInstance,
	options: AlertsApiRouteOptions,
): void {
	const { alertService, logger } = options;

	// GET /alerts — list all alert definitions
	server.get('/alerts', { preHandler: [requireScope('alerts:read')] }, async (request, reply) => {
		try {
			const alerts = await alertService.listAlerts();
			// D5b-7: filter by delivery-list visibility for non-admin actors
			const actor = request.actor;
			const visible = actor
				? alerts.filter((a) => isDeliveryVisible(actor, a.delivery))
				: alerts;
			return reply.send({ ok: true, alerts: visible });
		} catch (err) {
			logger.error({ err }, 'API alert list failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// GET /alerts/:id — get a single alert definition
	server.get('/alerts/:id', { preHandler: [requireScope('alerts:read')] }, async (request, reply) => {
		const { id } = request.params as { id: string };

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
		}

		try {
			const alert = await alertService.getAlert(id);
			if (!alert) {
				return reply.status(404).send({ ok: false, error: 'Alert not found.' });
			}
			// D5b-7: 403 when actor is not in the delivery list
			const actor = request.actor;
			if (actor && !isDeliveryVisible(actor, alert.delivery)) {
				return reply.status(403).send({ ok: false, error: 'Access denied.' });
			}
			return reply.send({ ok: true, alert });
		} catch (err) {
			logger.error({ err, alertId: id }, 'API alert get failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// POST /alerts/:id/evaluate — evaluate condition and execute actions if met
	server.post('/alerts/:id/evaluate', { preHandler: [requireScope('alerts:run')] }, async (request, reply) => {
		const { id } = request.params as { id: string };
		const body = request.body as { preview?: boolean } | undefined;

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
		}

		// D5b-7: evaluate is platform-admin / platform-system only in D5b
		const actor = request.actor;
		if (actor && !canRunAlerts(actor)) {
			return reply.status(403).send({ ok: false, error: 'Insufficient privileges to evaluate alerts.' });
		}

		try {
			const result = await alertService.evaluate(id, {
				preview: body?.preview ?? false,
			});

			if (result.error === 'Alert not found') {
				return reply.status(404).send({ ok: false, error: 'Alert not found.' });
			}

			logger.info(
				{ alertId: id, conditionMet: result.conditionMet, actionsExecuted: result.actionsExecuted },
				'API alert evaluated',
			);

			return reply.send({ ok: true, result });
		} catch (err) {
			logger.error({ err, alertId: id }, 'API alert evaluate failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// POST /alerts/:id/fire — evaluate condition and execute actions if met (alias for evaluate without preview)
	server.post('/alerts/:id/fire', { preHandler: [requireScope('alerts:run')] }, async (request, reply) => {
		const { id } = request.params as { id: string };

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
		}

		// D5b-7: fire is platform-admin / platform-system only in D5b
		const fireActor = request.actor;
		if (fireActor && !canRunAlerts(fireActor)) {
			return reply.status(403).send({ ok: false, error: 'Insufficient privileges to fire alerts.' });
		}

		try {
			const result = await alertService.evaluate(id);

			if (result.error === 'Alert not found') {
				return reply.status(404).send({ ok: false, error: 'Alert not found.' });
			}

			logger.info(
				{ alertId: id, conditionMet: result.conditionMet, actionsExecuted: result.actionsExecuted },
				'API alert fired',
			);

			return reply.send({ ok: true, result });
		} catch (err) {
			logger.error({ err, alertId: id }, 'API alert fire failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
