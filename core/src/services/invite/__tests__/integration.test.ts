/**
 * Integration tests for the full invite code lifecycle.
 *
 * Tests InviteService, UserManager, and UserMutationService together with
 * real filesystem I/O to verify end-to-end behaviour from code creation
 * through user registration and management.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemConfig } from '../../../types/config.js';
import type { AppToggleStore } from '../../app-toggle/index.js';
import { UserManager } from '../../user-manager/index.js';
import { UserMutationService } from '../../user-manager/user-mutation-service.js';
import { InviteService } from '../index.js';

// Mock only the logger
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

// Mock AppToggleStore
function createMockAppToggle(): AppToggleStore {
	return {
		isEnabled: vi.fn(async (_userId: string, appId: string, defaults: string[]) => {
			return defaults.includes('*') || defaults.includes(appId);
		}),
	} as unknown as AppToggleStore;
}

// Minimal valid SystemConfig with one admin user
function makeConfig(tmpDir: string): SystemConfig {
	return {
		port: 3000,
		dataDir: tmpDir,
		logLevel: 'info',
		timezone: 'UTC',
		telegram: { botToken: 'test-token' },
		claude: { apiKey: 'test-key', model: 'claude-3-5-sonnet-20241022' },
		gui: { authToken: 'test-gui-token' },
		api: { token: 'test-api-token' },
		cloudflare: {},
		fallback: 'chatbot',
		webhooks: [],
		n8n: { dispatchUrl: '' },
		users: [
			{
				id: '111',
				name: 'Admin',
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
			},
		],
	} as SystemConfig;
}

// Initial pas.yaml content matching the admin config
const INITIAL_PAS_YAML = `users:
  - id: "111"
    name: Admin
    is_admin: true
    enabled_apps:
      - "*"
    shared_scopes: []
`;

describe('Invite lifecycle integration', () => {
	let tmpDir: string;
	let configPath: string;
	let inviteService: InviteService;
	let userManager: UserManager;
	let mutationService: UserMutationService;

	beforeEach(async () => {
		// Each test gets a fresh temp directory
		tmpDir = await mkdtemp(join(tmpdir(), 'pas-invite-integration-'));
		configPath = join(tmpDir, 'pas.yaml');

		// Write initial config file
		await writeFile(configPath, INITIAL_PAS_YAML, 'utf-8');

		// Build real services
		inviteService = new InviteService({ dataDir: tmpDir, logger: mockLogger });
		userManager = new UserManager({
			config: makeConfig(tmpDir),
			appToggle: createMockAppToggle(),
			logger: mockLogger,
		});
		mutationService = new UserMutationService({
			userManager,
			configPath,
			logger: mockLogger,
		});
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('admin creates invite → new user redeems → user is active → config persisted (legacy two-step)', async () => {
		// 1. Admin creates an invite for Sarah
		const code = await inviteService.createInvite('Sarah', '111');
		expect(code).toHaveLength(8);

		// 2. Validate the code — should succeed
		const validation = await inviteService.validateCode(code);
		expect(validation).toHaveProperty('invite');
		const invite = (validation as { invite: { name: string } }).invite;
		expect(invite.name).toBe('Sarah');

		// 3. Register the new user
		await mutationService.registerUser({
			id: '222',
			name: invite.name,
			isAdmin: false,
			enabledApps: ['notes'],
			sharedScopes: [],
		});

		// 4. Redeem the invite code
		await inviteService.redeemCode(code, '222');

		// 5. Verify user is registered in memory
		expect(userManager.isRegistered('222')).toBe(true);

		// 6. Verify pas.yaml was updated with Sarah's details
		const configContent = await readFile(configPath, 'utf-8');
		expect(configContent).toContain('Sarah');
		expect(configContent).toContain('222');

		// 7. Verify the code cannot be reused
		const reuse = await inviteService.validateCode(code);
		expect(reuse).toHaveProperty('error');
		expect((reuse as { error: string }).error).toMatch(/already been used/i);
	});

	it('admin creates invite → new user claims atomically → user is active → config persisted', async () => {
		// 1. Admin creates an invite for Alex
		const code = await inviteService.createInvite('Alex', '111');
		expect(code).toHaveLength(8);

		// 2. Atomically claim and redeem
		const result = await inviteService.claimAndRedeem(code, '333');
		expect(result).toHaveProperty('invite');
		const invite = (result as { invite: { name: string } }).invite;
		expect(invite.name).toBe('Alex');

		// 3. Register the user
		await mutationService.registerUser({
			id: '333',
			name: invite.name,
			isAdmin: false,
			enabledApps: ['*'],
			sharedScopes: [],
		});

		// 4. Verify user is registered in memory and config
		expect(userManager.isRegistered('333')).toBe(true);
		const configContent = await readFile(configPath, 'utf-8');
		expect(configContent).toContain('Alex');
		expect(configContent).toContain('333');

		// 5. Retry with same userId (idempotent) — should succeed
		const retry = await inviteService.claimAndRedeem(code, '333');
		expect(retry).toHaveProperty('invite');

		// 6. Different user cannot claim the same code
		const contested = await inviteService.claimAndRedeem(code, '444');
		expect(contested).toHaveProperty('error');
		expect((contested as { error: string }).error).toMatch(/already been used/i);
	});

	it('removing user updates memory and config', async () => {
		// Add Bob first
		await mutationService.registerUser({
			id: '222',
			name: 'Bob',
			isAdmin: false,
			enabledApps: ['notes'],
			sharedScopes: [],
		});

		// Confirm Bob is in memory and config
		expect(userManager.isRegistered('222')).toBe(true);
		const beforeContent = await readFile(configPath, 'utf-8');
		expect(beforeContent).toContain('Bob');

		// Remove Bob (admin 111 is the caller)
		const result = await mutationService.removeUser('222', '111');
		expect(result).toEqual({});

		// Verify removed from memory
		expect(userManager.isRegistered('222')).toBe(false);

		// Verify removed from config
		const afterContent = await readFile(configPath, 'utf-8');
		expect(afterContent).not.toContain('Bob');
		expect(afterContent).not.toContain('222');
	});

	it('updating apps persists to config', async () => {
		// Update admin user 111's apps
		await mutationService.updateUserApps('111', ['food', 'notes']);

		// Verify in-memory
		expect(userManager.getUserApps('111')).toEqual(['food', 'notes']);

		// Verify config file
		const configContent = await readFile(configPath, 'utf-8');
		expect(configContent).toContain('food');
		expect(configContent).toContain('notes');
	});
});
