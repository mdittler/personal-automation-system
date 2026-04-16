/**
 * Alert management routes.
 *
 * GUI for creating, editing, testing, and managing conditional alerts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { isDeliveryVisible } from '../../gui/guards/resolve-viewer-scope.js';
import type { AlertService } from '../../services/alerts/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import {
	ALERT_ID_PATTERN,
	type AlertAction,
	type AlertCondition,
	type AlertDataSource,
	type AlertDefinition,
	type AlertTrigger,
} from '../../types/alert.js';
import {
	describeCron,
	formatDateTime,
	formatRelativeTime,
	getNextRun,
} from '../../utils/cron-describe.js';
import { safeJsonForScript } from '../../utils/escape-html.js';

export interface AlertRoutesOptions {
	alertService: AlertService;
	userManager: UserManager;
	registry?: { getAll(): Array<{ manifest: { app: { id: string; name: string } } }> };
	reportService?: { listReports(): Promise<Array<{ id: string; name: string }>> };
	spaceService?: { listSpaces(): Array<{ id: string; name: string }> };
	n8nDispatchUrl?: string;
	dataDir: string;
	timezone: string;
	logger: Logger;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function registerAlertRoutes(server: FastifyInstance, options: AlertRoutesOptions): void {
	const { alertService, userManager, registry, reportService, timezone } = options;

	async function getFormData() {
		const users = userManager.getAllUsers().map((u) => ({ id: u.id, name: u.name }));
		const apps = registry
			? registry.getAll().map((a) => ({ id: a.manifest.app.id, name: a.manifest.app.name }))
			: [];
		const reports = reportService
			? (await reportService.listReports()).map((r) => ({ id: r.id, name: r.name }))
			: [];
		const spaces = options.spaceService?.listSpaces() ?? [];
		const n8nUrl = options.n8nDispatchUrl || '';
		return { users, apps, reports, spaces, n8nUrl, safeJsonForScript };
	}

	// --- List ---
	server.get('/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		const allAlerts = await alertService.listAlerts();
		// D5b-5: non-admin sees only alerts where they are in the delivery list.
		const alerts = actor
			? allAlerts.filter((a) => isDeliveryVisible(a.delivery ?? [], actor))
			: allAlerts;
		const now = new Date();

		return reply.viewAsync('alerts', {
			title: 'Alerts — PAS',
			activePage: 'alerts',
			alerts: alerts.map((a) => {
				const isEvent = a.trigger?.type === 'event';
				const schedule = a.trigger?.schedule ?? a.schedule ?? '';
				const nextRun =
					!isEvent && a.enabled && !a._validationErrors?.length
						? getNextRun(schedule, timezone)
						: null;
				return {
					id: a.id,
					name: a.name ?? a.id,
					description: a.description,
					schedule,
					humanSchedule: isEvent
						? `On event: ${a.trigger?.event_name ?? '?'}`
						: describeCron(schedule),
					nextRun: nextRun ? formatDateTime(nextRun, timezone) : null,
					nextRunRelative: nextRun ? formatRelativeTime(nextRun, now) : null,
					conditionType: a.condition?.type ?? 'unknown',
					conditionExpr: a.condition?.expression ?? '',
					actionCount: a.actions?.length ?? 0,
					cooldown: a.cooldown,
					lastFired: a.lastFired ? formatDateTime(new Date(a.lastFired), timezone) : 'Never',
					enabled: a.enabled ?? false,
					validationErrors: a._validationErrors ?? [],
				};
			}),
		});
	});

	// --- New form ---
	server.get('/alerts/new', async (request: FastifyRequest, reply: FastifyReply) => {
		// D5b-5: only platform-admin can create alerts.
		if (request.user && !request.user.isPlatformAdmin) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}
		return reply.viewAsync('alert-edit', {
			title: 'Create Alert — PAS',
			activePage: 'alerts',
			isNew: true,
			alert: {
				id: '',
				name: '',
				description: '',
				enabled: true,
				schedule: '',
				condition: {
					type: 'deterministic',
					expression: '',
					data_sources: [],
				},
				actions: [],
				delivery: [],
				cooldown: '24 hours',
			},
			errors: [],
			...(await getFormData()),
		});
	});

	// --- Edit form ---
	server.get(
		'/alerts/:id/edit',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			// D5b-5: only platform-admin can edit alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
			}
			const alert = await alertService.getAlert(request.params.id);
			if (!alert) {
				return reply.code(404).send('Alert not found');
			}

			return reply.viewAsync('alert-edit', {
				title: `Edit ${alert.name} — PAS`,
				activePage: 'alerts',
				isNew: false,
				alert,
				errors: [],
				...(await getFormData()),
			});
		},
	);

	// --- Create (POST /alerts) ---
	server.post(
		'/alerts',
		async (request: FastifyRequest<{ Body: Record<string, string> }>, reply: FastifyReply) => {
			// D5b-5: only platform-admin can create alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).send('Forbidden');
			}
			const body = request.body as Record<string, string>;
			const def = parseFormToAlert(body);

			const errors = await alertService.saveAlert(def);
			if (errors.length > 0) {
				return reply.viewAsync('alert-edit', {
					title: 'Create Alert — PAS',
					activePage: 'alerts',
					isNew: true,
					alert: def,
					errors,
					...(await getFormData()),
				});
			}

			return reply.redirect(`/gui/alerts/${def.id}/edit`);
		},
	);

	// --- Update (POST /alerts/:id) ---
	server.post(
		'/alerts/:id',
		async (
			request: FastifyRequest<{
				Params: { id: string };
				Body: Record<string, string>;
			}>,
			reply: FastifyReply,
		) => {
			// D5b-5: only platform-admin can update alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).send('Forbidden');
			}
			const body = request.body as Record<string, string>;
			const def = parseFormToAlert(body);
			def.id = request.params.id;

			const errors = await alertService.saveAlert(def);
			if (errors.length > 0) {
				return reply.viewAsync('alert-edit', {
					title: 'Edit Alert — PAS',
					activePage: 'alerts',
					isNew: false,
					alert: def,
					errors,
					...(await getFormData()),
				});
			}

			return reply.redirect(`/gui/alerts/${def.id}/edit`);
		},
	);

	// --- Delete (POST /alerts/:id/delete) ---
	server.post(
		'/alerts/:id/delete',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			// D5b-5: only platform-admin can delete alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).send('Forbidden');
			}
			await alertService.deleteAlert(request.params.id);
			return reply.redirect('/gui/alerts');
		},
	);

	// --- Toggle (POST /alerts/:id/toggle) — htmx partial ---
	server.post(
		'/alerts/:id/toggle',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			// D5b-5: only platform-admin can toggle alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).send('Forbidden');
			}
			const alert = await alertService.getAlert(request.params.id);
			if (!alert) {
				return reply.code(404).send('Alert not found');
			}

			alert.enabled = !alert.enabled;
			await alertService.saveAlert(alert);

			const id = escapeHtml(alert.id);
			const label = alert.enabled ? 'On' : 'Off';
			const cls = alert.enabled ? 'secondary' : '';

			return reply
				.type('text/html')
				.send(
					`<form method="post" action="/gui/alerts/${id}/toggle" ` +
						`hx-post="/gui/alerts/${id}/toggle" ` +
						`hx-target="#toggle-${id}" hx-swap="innerHTML" style="margin:0">` +
						`<button type="submit" class="outline ${cls}" ` +
						`style="padding:0.15rem 0.5rem;margin:0;font-size:0.85rem">${label}</button></form>`,
				);
		},
	);

	// --- Test (POST /alerts/:id/test) — htmx partial ---
	server.post(
		'/alerts/:id/test',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			// D5b-5: only platform-admin can test/run alerts.
			if (request.user && !request.user.isPlatformAdmin) {
				return reply.status(403).type('text/html').send('<article><p>Access denied.</p></article>');
			}
			const result = await alertService.evaluate(request.params.id, {
				preview: true,
			});

			const status = result.conditionMet ? 'Condition MET' : 'Condition NOT met';
			const cls = result.conditionMet ? 'color:green' : 'color:gray';
			const error = result.error
				? `<br><small style="color:red">${escapeHtml(result.error)}</small>`
				: '';

			return reply
				.type('text/html')
				.send(
					`<article><p style="${cls}"><strong>${escapeHtml(status)}</strong></p>` +
						`<small>Preview only — no actions executed.</small>${error}</article>`,
				);
		},
	);

	// --- History list ---
	server.get(
		'/alerts/:id/history',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			const alert = await alertService.getAlert(request.params.id);
			if (!alert) {
				return reply.code(404).send('Alert not found');
			}

			const historyDir = join(
				resolve(options.dataDir),
				'system',
				'alert-history',
				request.params.id,
			);

			let files: string[] = [];
			try {
				const entries = await readdir(historyDir);
				files = entries
					.filter((f) => f.endsWith('.md'))
					.sort()
					.reverse();
			} catch {
				// No history directory yet
			}

			return reply.viewAsync('alert-history', {
				title: `History: ${alert.name} — PAS`,
				activePage: 'alerts',
				alertId: alert.id,
				alertName: alert.name,
				files: files.map((f) => ({ name: f })),
			});
		},
	);

	// --- History detail (htmx partial) ---
	server.get(
		'/alerts/:id/history/:file',
		async (
			request: FastifyRequest<{
				Params: { id: string; file: string };
			}>,
			reply: FastifyReply,
		) => {
			const { id, file } = request.params;

			// Validate alert ID format
			if (!ALERT_ID_PATTERN.test(id)) {
				return reply.code(400).send('Invalid alert ID');
			}

			// Validate file name: must be .md, no path traversal
			if (
				!file.endsWith('.md') ||
				file.includes('..') ||
				file.includes('/') ||
				file.includes('\\')
			) {
				return reply.code(400).send('Invalid file name');
			}

			const historyDir = join(resolve(options.dataDir), 'system', 'alert-history', id);
			const filePath = resolve(join(historyDir, file));

			// Path traversal check
			if (!filePath.startsWith(historyDir)) {
				return reply.code(400).send('Invalid path');
			}

			try {
				const content = await readFile(filePath, 'utf-8');
				return reply
					.type('text/html')
					.send(
						`<article><pre style="white-space:pre-wrap">${escapeHtml(content)}</pre></article>`,
					);
			} catch {
				return reply.code(404).send('History file not found');
			}
		},
	);
}

/**
 * Parse form body into an AlertDefinition.
 */
function parseFormToAlert(body: Record<string, string>): AlertDefinition {
	// Parse data sources from numbered fields
	const dataSources: AlertDataSource[] = [];
	for (let i = 0; i < 20; i++) {
		const appId = body[`ds_app_id_${i}`];
		if (!appId) continue;
		const scope = body[`ds_scope_${i}`];
		const spaceId = body[`ds_space_id_${i}`] || '';
		if (scope === 'space' || (!scope && spaceId)) {
			dataSources.push({ app_id: appId, space_id: spaceId, path: body[`ds_path_${i}`] || '' });
		} else {
			dataSources.push({
				app_id: appId,
				user_id: body[`ds_user_id_${i}`] || '',
				path: body[`ds_path_${i}`] || '',
			});
		}
	}

	// Parse condition
	const condition: AlertCondition = {
		type: (body.condition_type as 'deterministic' | 'fuzzy') || 'deterministic',
		expression: body.condition_expression || '',
		data_sources: dataSources,
	};

	// Parse actions from numbered fields
	const actions: AlertAction[] = [];
	for (let i = 0; i < 20; i++) {
		const type = body[`action_type_${i}`];
		if (!type) continue;

		let config: Record<string, unknown> = {};
		switch (type) {
			case 'telegram_message': {
				config = { message: body[`action_message_${i}`] || '' };
				if (body[`action_llm_summary_${i}`] === 'true') {
					config.llm_summary = { enabled: true };
				}
				break;
			}
			case 'run_report':
				config = { report_id: body[`action_report_id_${i}`] || '' };
				break;
			case 'webhook':
				config = {
					url: body[`action_webhook_url_${i}`] || '',
					include_data: body[`action_webhook_include_data_${i}`] === 'true',
				};
				break;
			case 'write_data':
				config = {
					app_id: body[`action_wd_app_id_${i}`] || '',
					user_id: body[`action_wd_user_id_${i}`] || '',
					path: body[`action_wd_path_${i}`] || '',
					content: body[`action_wd_content_${i}`] || '',
					mode: body[`action_wd_mode_${i}`] || 'append',
				};
				break;
			case 'audio':
				config = {
					message: body[`action_audio_message_${i}`] || '',
					device: body[`action_audio_device_${i}`] || undefined,
				};
				break;
			case 'dispatch_message':
				config = {
					text: body[`action_dispatch_text_${i}`] || '',
					user_id: body[`action_dispatch_user_id_${i}`] || '',
				};
				break;
		}

		actions.push({ type: type as any, config: config as any });
	}

	// Parse delivery as comma-separated
	const delivery = (body.delivery || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// Parse trigger
	const triggerType = body.trigger_type || 'scheduled';
	let trigger: AlertTrigger | undefined;
	if (triggerType === 'event') {
		trigger = {
			type: 'event',
			event_name: body.trigger_event_name || '',
		};
	} else {
		trigger = {
			type: 'scheduled',
			schedule: body.schedule || '',
		};
	}

	return {
		id: body.id || '',
		name: body.name || '',
		description: body.description || undefined,
		enabled: body.enabled === 'true',
		schedule: body.schedule || '',
		trigger,
		condition,
		actions,
		delivery,
		cooldown: body.cooldown || '',
	};
}
