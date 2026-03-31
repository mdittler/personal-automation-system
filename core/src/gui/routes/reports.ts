/**
 * Report management routes.
 *
 * GUI for creating, editing, previewing, and managing scheduled reports.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ReportService } from '../../services/reports/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type {
	ReportDefinition,
	ReportLLMConfig,
	ReportSection,
	SectionType,
} from '../../types/report.js';
import {
	describeCron,
	formatDateTime,
	formatRelativeTime,
	getNextRun,
} from '../../utils/cron-describe.js';

export interface ReportRoutesOptions {
	reportService: ReportService;
	userManager: UserManager;
	registry?: { getAll(): Array<{ manifest: { app: { id: string; name: string } } }> };
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

export function registerReportRoutes(server: FastifyInstance, options: ReportRoutesOptions): void {
	const { reportService, userManager, registry, timezone } = options;

	function getFormData() {
		const users = userManager.getAllUsers().map((u) => ({ id: u.id, name: u.name }));
		const apps = registry
			? registry.getAll().map((a) => ({ id: a.manifest.app.id, name: a.manifest.app.name }))
			: [];
		return { users, apps };
	}

	// --- List ---
	server.get('/reports', async (_request: FastifyRequest, reply: FastifyReply) => {
		const reports = await reportService.listReports();
		const now = new Date();

		return reply.viewAsync('reports', {
			title: 'Reports — PAS',
			activePage: 'reports',
			reports: reports.map((r) => {
				const nextRun = r.enabled ? getNextRun(r.schedule, timezone) : null;
				return {
					id: r.id,
					name: r.name,
					description: r.description,
					schedule: r.schedule,
					humanSchedule: describeCron(r.schedule),
					nextRun: nextRun ? formatDateTime(nextRun, timezone) : null,
					nextRunRelative: nextRun ? formatRelativeTime(nextRun, now) : null,
					sectionCount: r.sections.length,
					llmEnabled: r.llm?.enabled ?? false,
					enabled: r.enabled,
				};
			}),
		});
	});

	// --- New form ---
	server.get('/reports/new', async (_request: FastifyRequest, reply: FastifyReply) => {
		return reply.viewAsync('report-edit', {
			title: 'Create Report — PAS',
			activePage: 'reports',
			isNew: true,
			report: {
				id: '',
				name: '',
				description: '',
				enabled: true,
				schedule: '',
				delivery: [],
				sections: [],
				llm: { enabled: false },
			},
			errors: [],
			...getFormData(),
		});
	});

	// --- Edit form ---
	server.get(
		'/reports/:id/edit',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			const report = await reportService.getReport(request.params.id);
			if (!report) {
				return reply.code(404).send('Report not found');
			}

			return reply.viewAsync('report-edit', {
				title: `Edit ${report.name} — PAS`,
				activePage: 'reports',
				isNew: false,
				report,
				errors: [],
				...getFormData(),
			});
		},
	);

	// --- Create (POST /reports) ---
	server.post(
		'/reports',
		async (request: FastifyRequest<{ Body: Record<string, string> }>, reply: FastifyReply) => {
			const body = request.body as Record<string, string>;
			const def = parseFormToReport(body);

			const errors = await reportService.saveReport(def);
			if (errors.length > 0) {
				return reply.viewAsync('report-edit', {
					title: 'Create Report — PAS',
					activePage: 'reports',
					isNew: true,
					report: def,
					errors,
					...getFormData(),
				});
			}

			return reply.redirect(`/gui/reports/${def.id}/edit`);
		},
	);

	// --- Update (POST /reports/:id) ---
	server.post(
		'/reports/:id',
		async (
			request: FastifyRequest<{
				Params: { id: string };
				Body: Record<string, string>;
			}>,
			reply: FastifyReply,
		) => {
			const body = request.body as Record<string, string>;
			const def = parseFormToReport(body);
			// Force the ID from the URL param (readonly field in form)
			def.id = request.params.id;

			const errors = await reportService.saveReport(def);
			if (errors.length > 0) {
				return reply.viewAsync('report-edit', {
					title: 'Edit Report — PAS',
					activePage: 'reports',
					isNew: false,
					report: def,
					errors,
					...getFormData(),
				});
			}

			return reply.redirect(`/gui/reports/${def.id}/edit`);
		},
	);

	// --- Delete (POST /reports/:id/delete) ---
	server.post(
		'/reports/:id/delete',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			await reportService.deleteReport(request.params.id);
			return reply.redirect('/gui/reports');
		},
	);

	// --- Toggle (POST /reports/:id/toggle) — htmx partial ---
	server.post(
		'/reports/:id/toggle',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			const report = await reportService.getReport(request.params.id);
			if (!report) {
				return reply.code(404).send('Report not found');
			}

			report.enabled = !report.enabled;
			await reportService.saveReport(report);

			const id = escapeHtml(report.id);
			const label = report.enabled ? 'On' : 'Off';
			const cls = report.enabled ? 'secondary' : '';

			return reply
				.type('text/html')
				.send(
					`<form method="post" action="/gui/reports/${id}/toggle" ` +
						`hx-post="/gui/reports/${id}/toggle" ` +
						`hx-target="#toggle-${id}" hx-swap="innerHTML" style="margin:0">` +
						`<button type="submit" class="outline ${cls}" ` +
						`style="padding:0.15rem 0.5rem;margin:0;font-size:0.85rem">${label}</button></form>`,
				);
		},
	);

	// --- Preview (POST /reports/:id/preview) — htmx partial ---
	server.post(
		'/reports/:id/preview',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			const result = await reportService.run(request.params.id, {
				preview: true,
			});
			if (!result) {
				return reply.type('text/html').send('<article><p>Report not found.</p></article>');
			}

			return reply
				.type('text/html')
				.send(
					`<article><h4>Preview</h4><pre style="white-space:pre-wrap">${escapeHtml(result.markdown)}</pre></article>`,
				);
		},
	);

	// --- History list ---
	server.get(
		'/reports/:id/history',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			const report = await reportService.getReport(request.params.id);
			if (!report) {
				return reply.code(404).send('Report not found');
			}

			const historyDir = join(
				resolve(options.dataDir),
				'system',
				'report-history',
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

			return reply.viewAsync('report-history', {
				title: `History: ${report.name} — PAS`,
				activePage: 'reports',
				reportId: report.id,
				reportName: report.name,
				files: files.map((f) => ({ name: f })),
			});
		},
	);

	// --- History detail (htmx partial) ---
	server.get(
		'/reports/:id/history/:file',
		async (
			request: FastifyRequest<{
				Params: { id: string; file: string };
			}>,
			reply: FastifyReply,
		) => {
			const { id, file } = request.params;

			// Validate file name: must be .md, no path traversal
			if (
				!file.endsWith('.md') ||
				file.includes('..') ||
				file.includes('/') ||
				file.includes('\\')
			) {
				return reply.code(400).send('Invalid file name');
			}

			const historyDir = join(resolve(options.dataDir), 'system', 'report-history', id);
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
 * Parse form body into a ReportDefinition.
 */
function parseFormToReport(body: Record<string, string>): ReportDefinition {
	// Parse sections from numbered fields
	const sections: ReportSection[] = [];
	for (let i = 0; i < 100; i++) {
		const type = body[`section_type_${i}`] as SectionType | undefined;
		if (!type) continue;

		const label = body[`section_label_${i}`] || '';
		let config: Record<string, unknown> = {};

		switch (type) {
			case 'changes':
				config = {
					lookback_hours: Number.parseInt(body[`section_lookback_${i}`] || '24', 10) || 24,
					app_filter: (body[`section_app_filter_${i}`] || '')
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean),
				};
				break;
			case 'app-data':
				config = {
					app_id: body[`section_app_id_${i}`] || '',
					user_id: body[`section_user_id_${i}`] || '',
					path: body[`section_path_${i}`] || '',
				};
				break;
			case 'context':
				config = {
					key_prefix: body[`section_key_prefix_${i}`] || '',
				};
				break;
			case 'custom':
				config = {
					text: body[`section_text_${i}`] || '',
				};
				break;
		}

		sections.push({ type, label, config: config as any });
	}

	// Parse delivery as comma-separated
	const delivery = (body.delivery || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// Parse LLM config
	const llm: ReportLLMConfig = {
		enabled: body.llm_enabled === 'true',
		prompt: body.llm_prompt || undefined,
		tier: (body.llm_tier as any) || 'standard',
		max_tokens: Number.parseInt(body.llm_max_tokens || '500', 10) || 500,
	};

	return {
		id: body.id || '',
		name: body.name || '',
		description: body.description || undefined,
		enabled: body.enabled === 'true',
		schedule: body.schedule || '',
		delivery,
		sections,
		llm,
	};
}
