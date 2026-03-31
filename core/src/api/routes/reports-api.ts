/**
 * Report API endpoints.
 *
 * Exposes report CRUD and execution for external orchestration (n8n).
 * - GET  /reports        — list all report definitions
 * - GET  /reports/:id    — get a single report definition
 * - POST /reports/:id/run     — collect data, format, save to history, deliver
 * - POST /reports/:id/deliver — send pre-built content to delivery users
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ReportService } from '../../services/reports/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { REPORT_ID_PATTERN } from '../../types/report.js';
import type { TelegramService } from '../../types/telegram.js';

const MAX_CONTENT_LENGTH = 50_000;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface ReportsApiRouteOptions {
	reportService: ReportService;
	telegram: TelegramService;
	userManager: UserManager;
	logger: Logger;
}

export function registerReportsApiRoute(
	server: FastifyInstance,
	options: ReportsApiRouteOptions,
): void {
	const { reportService, telegram, userManager, logger } = options;

	// GET /reports — list all report definitions
	server.get('/reports', async (_request, reply) => {
		try {
			const reports = await reportService.listReports();
			return reply.send({ ok: true, reports });
		} catch (err) {
			logger.error({ err }, 'API report list failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// GET /reports/:id — get a single report definition
	server.get('/reports/:id', async (request, reply) => {
		const { id } = request.params as { id: string };

		if (!REPORT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid report ID format.' });
		}

		try {
			const report = await reportService.getReport(id);
			if (!report) {
				return reply.status(404).send({ ok: false, error: 'Report not found.' });
			}
			return reply.send({ ok: true, report });
		} catch (err) {
			logger.error({ err, reportId: id }, 'API report get failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// POST /reports/:id/run — execute report (collect, format, save, deliver)
	server.post('/reports/:id/run', async (request, reply) => {
		const { id } = request.params as { id: string };
		const body = request.body as { preview?: boolean } | undefined;

		if (!REPORT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid report ID format.' });
		}

		try {
			const result = await reportService.run(id, { preview: body?.preview ?? false });
			if (!result) {
				return reply.status(404).send({ ok: false, error: 'Report not found.' });
			}
			return reply.send({ ok: true, result });
		} catch (err) {
			logger.error({ err, reportId: id }, 'API report run failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});

	// POST /reports/:id/deliver — send content to delivery users via Telegram
	server.post('/reports/:id/deliver', async (request, reply) => {
		const { id } = request.params as { id: string };
		const body = request.body as { content?: string; userIds?: string[] } | undefined;

		if (!REPORT_ID_PATTERN.test(id)) {
			return reply.status(400).send({ ok: false, error: 'Invalid report ID format.' });
		}

		if (!body?.content || typeof body.content !== 'string') {
			return reply.status(400).send({ ok: false, error: 'Missing required field: content' });
		}

		if (body.content.length > MAX_CONTENT_LENGTH) {
			return reply.status(400).send({
				ok: false,
				error: `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
			});
		}

		// Determine recipients: explicit userIds or report's delivery list
		let recipients: string[];
		if (body.userIds && Array.isArray(body.userIds)) {
			// Validate all userIds are strings with valid format
			const invalidFormat = body.userIds.filter(
				(uid) => typeof uid !== 'string' || !USER_ID_PATTERN.test(uid),
			);
			if (invalidFormat.length > 0) {
				return reply
					.status(400)
					.send({ ok: false, error: 'Invalid userId format in userIds array.' });
			}
			// Validate all userIds are registered
			const invalidUsers = body.userIds.filter((uid) => !userManager.isRegistered(uid));
			if (invalidUsers.length > 0) {
				return reply.status(403).send({
					ok: false,
					error: `Unregistered user(s): ${invalidUsers.join(', ')}`,
				});
			}
			recipients = body.userIds;
		} else {
			const report = await reportService.getReport(id);
			if (!report) {
				return reply.status(404).send({ ok: false, error: 'Report not found.' });
			}
			recipients = report.delivery;
		}

		if (recipients.length === 0) {
			return reply.status(400).send({ ok: false, error: 'No delivery recipients.' });
		}

		try {
			let delivered = 0;
			const errors: string[] = [];

			for (const userId of recipients) {
				try {
					await telegram.send(userId, body.content);
					delivered++;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					errors.push(`${userId}: ${msg}`);
					logger.error({ err, reportId: id, userId }, 'Failed to deliver report to user');
				}
			}

			logger.info({ reportId: id, delivered, total: recipients.length }, 'API report delivered');

			return reply.send({
				ok: true,
				delivered,
				total: recipients.length,
				errors: errors.length > 0 ? errors : undefined,
			});
		} catch (err) {
			logger.error({ err, reportId: id }, 'API report deliver failed');
			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
