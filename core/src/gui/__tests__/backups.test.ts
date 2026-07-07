/**
 * Backups status page (Batch 6, Task 6.2).
 *
 * `/gui/backups` — admin-only. The GUI never receives a live BackupService
 * instance (bootstrap builds one after GUI registration, cron-only,
 * RuntimeServices.backupService is always undefined) — this route
 * constructs its OWN BackupService from backupConfig + dataDir/configDir
 * when enabled. createBackup() throws on tar/empty-archive failure and
 * returns '' only on Windows — both paths must render a styled error via
 * sendErrorFragment, never a 500.
 *
 * Per project convention (no shared buildTestServer helper), this file
 * builds its own Fastify app via the per-file `buildApp` pattern used by
 * admin-route-guards.test.ts.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialService } from '../../services/credentials/index.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { describeCron } from '../../utils/cron-describe.js';
import { registerAuth } from '../auth.js';
import { registerCsrfProtection } from '../csrf.js';
import { registerBackupsRoutes } from '../routes/backups.js';
import { registerViewLocals } from '../view-locals.js';

const AUTH_TOKEN = 'test-token';
const logger = pino({ level: 'silent' });
const moduleDir = join(fileURLToPath(import.meta.url), '..', '..');
const viewsDir = join(moduleDir, 'views');

const ADMIN_ID = 'admin-1';
const MEMBER_ID = 'member-1';

function makeUserManager(): Pick<UserManager, 'getUser' | 'getAllUsers'> {
	const users = [
		{ id: ADMIN_ID, name: 'Admin', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
		{ id: MEMBER_ID, name: 'Member', isAdmin: false, enabledApps: ['*'], sharedScopes: [] },
	];
	return {
		getUser: (id: string) => users.find((u) => u.id === id) ?? null,
		getAllUsers: () => users,
	} as unknown as Pick<UserManager, 'getUser' | 'getAllUsers'>;
}

function makeHouseholdService(): Pick<HouseholdService, 'getHouseholdForUser' | 'getHousehold'> {
	return {
		getHouseholdForUser: () => 'hh-1',
		getHousehold: (id: string) => (id === 'hh-1' ? { id: 'hh-1', adminUserIds: [ADMIN_ID] } : null),
	};
}

function collectCookies(
	...responses: Array<{ cookies: Array<{ name: string; value: string }> }>
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const res of responses) {
		for (const c of res.cookies) {
			result[c.name] = c.value;
		}
	}
	return result;
}

let tempDir: string;
let dataDir: string;
let configDir: string;
let backupPath: string;
let app: Awaited<ReturnType<typeof Fastify>>;

async function buildApp(
	dir: string,
	backupConfig: { enabled: boolean; path: string; schedule: string; retentionCount: number },
	execFileAsyncOverride?: (
		cmd: string,
		args: string[],
	) => Promise<{ stdout: string; stderr: string }>,
) {
	const credentialService = new CredentialService({ dataDir: dir });
	await credentialService.setPassword(ADMIN_ID, 'admin-pass-123');
	await credentialService.setPassword(MEMBER_ID, 'member-pass-123');

	const userManager = makeUserManager();
	const householdService = makeHouseholdService();

	const fastifyApp = Fastify({ logger: false });
	await fastifyApp.register(fastifyCookie, { secret: AUTH_TOKEN });

	const eta = new Eta();
	await fastifyApp.register(fastifyView, {
		engine: { eta },
		root: viewsDir,
		viewExt: 'eta',
		layout: 'layout',
	});

	await fastifyApp.register(
		async (gui) => {
			await registerAuth(gui, {
				authToken: AUTH_TOKEN,
				credentialService,
				userManager: userManager as unknown as UserManager,
				householdService: householdService as unknown as HouseholdService,
			});
			await registerCsrfProtection(gui);
			await registerViewLocals(gui, { userManager: userManager as unknown as UserManager });
			registerBackupsRoutes(gui, {
				backupConfig,
				dataDir,
				configDir,
				logger,
				_execFileAsync: execFileAsyncOverride,
			});
		},
		{ prefix: '/gui' },
	);

	return fastifyApp;
}

async function login(userId: string, password: string): Promise<Record<string, string>> {
	const res = await app.inject({
		method: 'POST',
		url: '/gui/login',
		payload: { userId, password },
	});
	expect(res.statusCode).toBe(302);
	return collectCookies(res);
}

async function getCsrf(cookies: Record<string, string>) {
	const res = await app.inject({ method: 'GET', url: '/gui/backups', cookies });
	expect(res.statusCode).toBe(200);
	const allCookies = { ...cookies, ...collectCookies(res) };
	const metaMatch = res.body.match(/name="csrf-token" content="([^"]+)"/);
	const csrfToken = metaMatch?.[1] ?? '';
	expect(csrfToken).not.toBe('');
	return { cookies: allCookies, csrfToken };
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-backups-'));
	dataDir = join(tempDir, 'data');
	configDir = join(tempDir, 'config');
	backupPath = join(tempDir, 'backups');
	await mkdir(dataDir, { recursive: true });
	await mkdir(configDir, { recursive: true });
	await writeFile(join(dataDir, 'placeholder.md'), '# placeholder', 'utf-8');
});

afterEach(async () => {
	await app.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe('Backups (/gui/backups)', () => {
	it('admin-only (member → 403)', async () => {
		app = await buildApp(tempDir, {
			enabled: false,
			path: backupPath,
			schedule: '0 3 * * *',
			retentionCount: 7,
		});
		const cookies = await login(MEMBER_ID, 'member-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/backups', cookies });
		expect(res.statusCode).toBe(403);
	});

	it('POST /gui/backups/run is also admin-only (member → 403)', async () => {
		app = await buildApp(tempDir, {
			enabled: true,
			path: backupPath,
			schedule: '0 3 * * *',
			retentionCount: 7,
		});
		const cookies = await login(MEMBER_ID, 'member-pass-123');
		const res = await app.inject({
			method: 'POST',
			url: '/gui/backups/run',
			payload: { _csrf: 'whatever' },
			cookies,
		});
		expect(res.statusCode).toBe(403);
	});

	it('disabled state: shows the exact pas.yaml snippet and no Back up now button', async () => {
		app = await buildApp(tempDir, {
			enabled: false,
			path: backupPath,
			schedule: '0 3 * * *',
			retentionCount: 7,
		});
		const cookies = await login(ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/backups', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('enabled: true');
		expect(res.body).toContain('backup:');
		expect(res.body.toLowerCase()).toContain('restart');
		expect(res.body).not.toContain('Back up now');
	});

	it('enabled state: shows a human-readable cron description, not the raw cron expression (C2 fix)', async () => {
		app = await buildApp(tempDir, {
			enabled: true,
			path: backupPath,
			schedule: '0 3 * * *',
			retentionCount: 7,
		});
		const cookies = await login(ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/backups', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain(describeCron('0 3 * * *'));
		expect(res.body).not.toContain('( 0 3 * * * )');
		expect(res.body).not.toContain('<code>0 3 * * *</code>');
	});

	it('enabled state: lists archives (name, size, date) newest first and shows last-backup freshness', async () => {
		await mkdir(backupPath, { recursive: true });
		await writeFile(join(backupPath, 'pas-backup-2026-01-01T00-00-00.tar.gz'), 'x'.repeat(100));
		await new Promise((r) => setTimeout(r, 10));
		await writeFile(join(backupPath, 'pas-backup-2026-01-02T00-00-00.tar.gz'), 'x'.repeat(200));

		app = await buildApp(tempDir, {
			enabled: true,
			path: backupPath,
			schedule: '0 3 * * *',
			retentionCount: 7,
		});
		const cookies = await login(ADMIN_ID, 'admin-pass-123');
		const res = await app.inject({ method: 'GET', url: '/gui/backups', cookies });

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('pas-backup-2026-01-01T00-00-00.tar.gz');
		expect(res.body).toContain('pas-backup-2026-01-02T00-00-00.tar.gz');
		expect(res.body).toContain('Back up now');
		// Newest first.
		const idx1 = res.body.indexOf('pas-backup-2026-01-02T00-00-00.tar.gz');
		const idx2 = res.body.indexOf('pas-backup-2026-01-01T00-00-00.tar.gz');
		expect(idx1).toBeLessThan(idx2);
	});

	it('POST /gui/backups/run creates a backup via BackupService and reports the archive name; CSRF required', async () => {
		app = await buildApp(
			tempDir,
			{ enabled: true, path: backupPath, schedule: '0 3 * * *', retentionCount: 7 },
			async (_cmd: string, args: string[]) => {
				const destPath = args[1] as string;
				await writeFile(destPath, 'fake archive contents', 'utf-8');
				return { stdout: '', stderr: '' };
			},
		);

		const loginCookies = await login(ADMIN_ID, 'admin-pass-123');
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		// Missing CSRF is rejected.
		const noCsrfRes = await app.inject({
			method: 'POST',
			url: '/gui/backups/run',
			payload: { _csrf: 'invalid' },
			cookies,
		});
		expect(noCsrfRes.statusCode).toBe(403);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/backups/run',
			payload: { _csrf: csrfToken },
			cookies,
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/pas-backup-.*\.tar\.gz/);
	});

	it('backup failure renders a styled error, not a 500', async () => {
		app = await buildApp(
			tempDir,
			{ enabled: true, path: backupPath, schedule: '0 3 * * *', retentionCount: 7 },
			async () => {
				throw new Error('tar: command failed');
			},
		);

		const loginCookies = await login(ADMIN_ID, 'admin-pass-123');
		const { cookies, csrfToken } = await getCsrf(loginCookies);

		const res = await app.inject({
			method: 'POST',
			url: '/gui/backups/run',
			payload: { _csrf: csrfToken },
			cookies,
		});

		expect(res.statusCode).toBe(400);
		expect(res.body).toContain('pas-error-card');
		expect(res.body).not.toMatch(/Error:|at .*\.ts:\d+/);
	});
});
