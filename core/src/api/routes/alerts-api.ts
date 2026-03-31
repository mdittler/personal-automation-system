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
import type { AlertService } from '../../services/alerts/index.js';
import { ALERT_ID_PATTERN } from '../../types/alert.js';

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
	server.get('/alerts', async (_request, reply) => {
		try {
			const alerts = await alertService.listAlerts();
			return reply.send({ ok: true, alerts });
		} catch (err) {
			logger.error({ err }, 'API alert list failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// GET /alerts/:id — get a single alert definition
	server.get('/alerts/:id', async (request, reply) => {
		const { id } = request.params as { id: string };

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
		}

		try {
			const alert = await alertService.getAlert(id);
			if (!alert) {
				return reply.status(404).send({ ok: false, error: 'Alert not found.' });
			}
			return reply.send({ ok: true, alert });
		} catch (err) {
			logger.error({ err, alertId: id }, 'API alert get failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// POST /alerts/:id/evaluate — evaluate condition and execute actions if met
	server.post('/alerts/:id/evaluate', async (request, reply) => {
		const { id } = request.params as { id: string };
		const body = request.body as { preview?: boolean } | undefined;

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
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
	server.post('/alerts/:id/fire', async (request, reply) => {
		const { id } = request.params as { id: string };

		if (!ALERT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid alert ID format.' });
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
