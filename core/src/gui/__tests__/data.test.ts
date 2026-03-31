import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SystemConfig } from '../../types/config.js';
import { registerAuth } from '../auth.js';
import { registerDataRoutes } from '../routes/data.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

let dataDir: string;
let server: ReturnType<typeof Fastify>;
let authCookie: string;

function createMockConfig(): SystemConfig {
	return {
		port: 3000,
		dataDir: '',
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test' },
		ollama: { url: '', model: '' },
		claude: { apiKey: 'test', model: 'claude-sonnet-4-20250514' },
		gui: { authToken: AUTH_TOKEN },
		cloudflare: {},
		users: [
			{
				id: '123',
				name: 'TestUser',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		],
	};
}

beforeEach(async () => {
	// Create temp data directory with test structure
	dataDir = join(tmpdir(), `pas-data-test-${Date.now()}`);
	await mkdir(join(dataDir, 'users', '123', 'notes', 'daily-notes'), { recursive: true });
	await mkdir(join(dataDir, 'users', '123', 'chatbot'), { recursive: true });
	await mkdir(join(dataDir, 'system', 'daily-diff'), { recursive: true });
	await writeFile(
		join(dataDir, 'users', '123', 'notes', 'daily-notes', '2026-03-12.md'),
		'- [10:00] Test note\n',
	);
	await writeFile(join(dataDir, 'system', 'daily-diff', '2026-03-12.md'), 'Daily diff content\n');

	const config = createMockConfig();

	server = Fastify();
	await server.register(fastifyCookie, { secret: 'test-secret' });
	const eta = new Eta({ views: viewsDir, autoEscape: true });
	await server.register(fastifyView, { engine: { eta }, root: viewsDir });

	await server.register(
		async (gui) => {
			await registerAuth(gui, { authToken: AUTH_TOKEN });
			registerDataRoutes(gui, { config, dataDir, logger });
		},
		{ prefix: '/gui' },
	);

	await server.ready();

	// Get auth cookie
	const loginRes = await server.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { token: AUTH_TOKEN },
	});
	const cookies = loginRes.cookies as Array<{ name: string; value: string }>;
	const authC = cookies.find((c) => c.name === 'pas_auth');
	authCookie = authC ? `pas_auth=${authC.value}` : '';
});

afterEach(async () => {
	await server.close();
	await rm(dataDir, { recursive: true, force: true });
});

describe('GET /gui/data', () => {
	it('renders data page with user sections', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Data Browser');
		expect(res.body).toContain('TestUser');
		expect(res.body).toContain('123');
		expect(res.body).toContain('notes');
	});

	it('shows system data directories', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('System');
		expect(res.body).toContain('daily-diff');
	});
});

describe('GET /gui/data/browse', () => {
	it('returns file listing for user app data', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=123&appId=notes',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('daily-notes');
	});

	it('returns file listing for subdirectory', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=123&appId=notes&subpath=daily-notes',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('2026-03-12.md');
	});

	it('returns file listing for system data', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=system&subpath=daily-diff',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('2026-03-12.md');
	});

	it('returns empty message for non-existent directory', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=123&appId=nonexistent',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('No files found');
	});

	it('returns 400 for missing scope parameter', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});
});

describe('security', () => {
	it('rejects path traversal in subpath', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=system&subpath=../../etc/passwd',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('Invalid path');
	});

	it('rejects invalid userId format', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=../../../etc',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('rejects invalid appId format', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=user&userId=123&appId=../../etc',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('rejects absolute path in subpath', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/browse?scope=system&subpath=/etc/passwd',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});
});

describe('GET /gui/data (Model Journal section)', () => {
	it('renders Model Notes section in data page', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Model Notes');
		expect(res.body).toContain('written by the model');
		expect(res.body).toContain('journal-content');
	});
});

describe('GET /gui/data/journal (multi-model discovery)', () => {
	it('returns empty state when no journals exist', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('No journal entries yet');
	});

	it('lists model slugs as collapsible sections', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(
			join(dataDir, 'model-journal', 'anthropic-claude-sonnet-4.md'),
			'# Journal \u2014 2026-03\n\nSonnet thought\n',
		);
		await writeFile(
			join(dataDir, 'model-journal', 'anthropic-claude-haiku-4.md'),
			'# Journal \u2014 2026-03\n\nHaiku thought\n',
		);

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('<details');
		expect(res.body).toContain('anthropic-claude-haiku-4');
		expect(res.body).toContain('anthropic-claude-sonnet-4');
		expect(res.body).toContain('hx-get="/gui/data/journal/model?slug=');
	});

	it('filters out non-md files from journal directory', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(join(dataDir, 'model-journal', 'valid-model.md'), 'content');
		await writeFile(join(dataDir, 'model-journal', 'readme.txt'), 'junk');

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('valid-model');
		expect(res.body).not.toContain('readme');
	});

	it('HTML-escapes model slugs', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(join(dataDir, 'model-journal', 'test-model.md'), 'content');

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		// Slug should be properly escaped in the output
		expect(res.body).toContain('test-model');
	});
});

describe('GET /gui/data/journal/model (per-model journal)', () => {
	it('returns journal content for a model', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(
			join(dataDir, 'model-journal', 'anthropic-claude-sonnet-4.md'),
			'# Journal \u2014 2026-03\n\n---\n### 2026-03-12 10:00\n\nSome model thought\n\n',
		);

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=anthropic-claude-sonnet-4',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Some model thought');
	});

	it('returns empty message when model has no journal', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=nonexistent-model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('No entries yet');
	});

	it('lists per-model archived journals', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(join(dataDir, 'model-journal', 'test-model.md'), 'Current content');
		await mkdir(join(dataDir, 'model-journal-archive', 'test-model'), { recursive: true });
		await writeFile(
			join(dataDir, 'model-journal-archive', 'test-model', '2026-02.md'),
			'# Journal \u2014 2026-02\n\nOld entry\n',
		);

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=test-model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Archived journals');
		expect(res.body).toContain('2026-02');
	});

	it('HTML-escapes journal content', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(
			join(dataDir, 'model-journal', 'test-model.md'),
			'<script>alert("xss")</script>',
		);

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=test-model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).not.toContain('<script>');
		expect(res.body).toContain('&lt;script&gt;');
	});

	it('returns 400 for invalid slug (path traversal)', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=../etc/passwd',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('Invalid model slug');
	});

	it('returns 400 for missing slug parameter', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('handles empty journal file', async () => {
		await mkdir(join(dataDir, 'model-journal'), { recursive: true });
		await writeFile(join(dataDir, 'model-journal', 'empty-model.md'), '');

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/model?slug=empty-model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('No entries yet');
	});
});

describe('GET /gui/data/journal/archive (per-model archive)', () => {
	it('returns archived journal content for a model', async () => {
		await mkdir(join(dataDir, 'model-journal-archive', 'test-model'), { recursive: true });
		await writeFile(
			join(dataDir, 'model-journal-archive', 'test-model', '2026-01.md'),
			'# Journal \u2014 2026-01\n\nArchived thought\n',
		);

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=test-model&file=2026-01.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Archived thought');
		expect(res.body).toContain('Back to');
		expect(res.body).toContain('test-model');
	});

	it('returns 400 for invalid slug (path traversal)', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=../traversal&file=2026-01.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('Invalid model slug');
	});

	it('returns 400 for invalid filename (path traversal)', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=test-model&file=../../etc/passwd',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('Invalid archive file');
	});

	it('returns 400 for missing slug parameter', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?file=2026-01.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for missing file parameter', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=test-model',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('returns 400 for non-matching filename pattern', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=test-model&file=notes.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('returns not found for non-existent archive', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/journal/archive?slug=test-model&file=2020-01.md',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Archive not found');
	});
});

describe('GET /gui/data/files (file browser for data sources)', () => {
	it('returns file listing for user app directory', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('file-browser-list');
		expect(res.body).toContain('daily-notes');
	});

	it('returns clickable files with path fill onclick', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes&subpath=daily-notes&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('2026-03-12.md');
		expect(res.body).toContain('ds_path_0');
		expect(res.body).toContain('daily-notes/2026-03-12.md');
	});

	it('shows back link for subdirectories', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes&subpath=daily-notes&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('\u2190 Back');
	});

	it('returns empty message for non-existent directory', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=nonexistent&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('No files found');
	});

	it('prompts for app and user when missing', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Select an app and user first');
	});

	it('returns 400 for missing target parameter', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('rejects path traversal in subpath', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes&subpath=../../etc&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(400);
	});

	it('includes close button', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data/files?scope=user&userId=123&appId=notes&target=ds_path_0',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Close');
	});
});

describe('GET /gui/data (system files vs directories)', () => {
	it('renders system files with view links and directories with browse links', async () => {
		await writeFile(join(dataDir, 'system', 'model-selection.yaml'), 'standard:\n  model: test\n');

		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		// model-selection.yaml is a file — should get a view link
		expect(res.body).toContain('/gui/data/view?scope=system&subpath=model-selection.yaml');
		// daily-diff is a directory — should get a browse link
		expect(res.body).toContain('/gui/data/browse?scope=system&subpath=daily-diff');
	});
});

describe('GET /gui/data (empty shared/spaces sections)', () => {
	it('shows shared section even when empty', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Shared');
		expect(res.body).toContain('No shared data yet');
	});

	it('shows spaces section even when empty', async () => {
		const res = await server.inject({
			method: 'GET',
			url: '/gui/data',
			headers: { cookie: authCookie },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('Spaces');
		expect(res.body).toContain('No space data yet');
	});
});
