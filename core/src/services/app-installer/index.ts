/**
 * App installer for PAS.
 *
 * Supports both a review-first planning phase and the legacy one-shot
 * installApp() wrapper used by existing callers.
 */

import { execFile as execFileCb } from 'node:child_process';
import { cp, lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateManifest } from '../../schemas/validate-manifest.js';
import type { AppManifest } from '../../types/manifest.js';
import { parseYaml } from '../../utils/yaml.js';
import { checkCompatibility } from './compatibility-checker.js';
import { analyzeApp } from './static-analyzer.js';

const execFile = promisify(execFileCb);

export interface InstallOptions {
	/** Git URL to clone (HTTPS or SSH). */
	gitUrl: string;
	/** Absolute path to the apps/ directory. */
	appsDir: string;
	/** Running CoreServices version from core/package.json. */
	coreVersion: string;
}

export interface InstallError {
	type:
		| 'BANNED_IMPORT'
		| 'INCOMPATIBLE'
		| 'INVALID_MANIFEST'
		| 'ALREADY_INSTALLED'
		| 'CLONE_FAILED'
		| 'COPY_FAILED'
		| 'INSTALL_DEPS_FAILED'
		| 'INVALID_GIT_URL'
		| 'INVALID_STATE'
		| 'SYMLINK_FOUND';
	message: string;
	details?: string;
}

export interface PermissionSummary {
	services: string[];
	dataScopes: { path: string; access: string }[];
	externalApis: { id: string; envVar: string; required: boolean }[];
	llm?: { tier?: string; costCap?: number };
}

export interface InstallResult {
	success: boolean;
	appId?: string;
	errors: InstallError[];
	permissionSummary?: PermissionSummary;
}

export interface PreparedInstall {
	appId: string;
	permissionSummary: PermissionSummary;
	commit(): Promise<InstallResult>;
	/**
	 * Best-effort temp cleanup. Safe to call more than once, but callers must not
	 * run dispose() concurrently with commit().
	 */
	dispose(): Promise<void>;
}

export interface PlanInstallResult {
	success: boolean;
	errors: InstallError[];
	appId?: string;
	permissionSummary?: PermissionSummary;
	preparedInstall?: PreparedInstall;
}

/**
 * Regex for valid git URLs:
 *   https://... or git@...:...
 * Rejects file://, bare paths, and shell metacharacters.
 */
const GIT_URL_PATTERN = /^(https?:\/\/[^\s]+|git@[^\s]+:\S+)$/;

/** Characters that could be used for shell injection. */
const SHELL_METACHAR_PATTERN = /[;&|`$(){}!<>]/;

/** Valid app ID pattern from manifest schema. */
const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** App IDs reserved by the infrastructure (conflict with data paths or system concepts). */
const RESERVED_IDS = new Set(['shared', 'system', 'core', 'pas', 'internal']);

const MAX_MANIFEST_SIZE = 1024 * 1024; // 1MB

interface PreparedPlanData {
	tempDir: string;
	appId: string;
	targetDir: string;
	permissionSummary: PermissionSummary;
	appsDir: string;
}

/**
 * Validate a git URL for safety.
 */
function validateGitUrl(url: string): InstallError | null {
	if (!url || typeof url !== 'string') {
		return { type: 'INVALID_GIT_URL', message: 'Git URL is required.' };
	}

	if (url.startsWith('file://')) {
		return {
			type: 'INVALID_GIT_URL',
			message: 'file:// URLs are not allowed for security reasons.',
		};
	}

	if (SHELL_METACHAR_PATTERN.test(url)) {
		return { type: 'INVALID_GIT_URL', message: 'Git URL contains invalid characters.' };
	}

	if (!GIT_URL_PATTERN.test(url)) {
		return {
			type: 'INVALID_GIT_URL',
			message: `Invalid git URL format: "${url}". Use HTTPS or SSH URLs.`,
		};
	}

	return null;
}

/**
 * Build a permission summary from a validated manifest.
 */
function buildPermissionSummary(manifest: AppManifest): PermissionSummary {
	const reqs = manifest.requirements;
	return {
		services: reqs?.services ?? [],
		dataScopes: [
			...(reqs?.data?.user_scopes ?? []).map((s) => ({ path: s.path, access: s.access })),
			...(reqs?.data?.shared_scopes ?? []).map((s) => ({ path: s.path, access: s.access })),
		],
		externalApis: (reqs?.external_apis ?? []).map((a) => ({
			id: a.id,
			envVar: a.env_var,
			required: a.required,
		})),
		llm: reqs?.llm
			? {
					tier: reqs.llm.tier,
					costCap: reqs.llm.monthly_cost_cap,
				}
			: undefined,
	};
}

/**
 * Recursively scan a directory for symlinks or other non-regular entries.
 * Returns the relative path of the first symlink found, or null if clean.
 */
async function findSymlinks(dir: string, baseDir: string): Promise<string | null> {
	const entries = await readdir(dir);
	for (const entry of entries) {
		const fullPath = join(dir, entry);
		const stats = await lstat(fullPath);
		if (stats.isSymbolicLink()) {
			return fullPath.slice(baseDir.length + 1);
		}
		if (stats.isDirectory()) {
			const found = await findSymlinks(fullPath, baseDir);
			if (found) return found;
		}
	}
	return null;
}

async function cloneRepository(gitUrl: string, tempDir: string): Promise<InstallError | null> {
	try {
		await execFile('git', ['clone', '--depth', '1', gitUrl, tempDir], { timeout: 60_000 });
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { type: 'CLONE_FAILED', message: 'Git clone failed.', details: message };
	}
}

async function validatePreparedInstall(
	options: InstallOptions,
	tempDir: string,
): Promise<PreparedPlanData | InstallError[]> {
	const symlinkPath = await findSymlinks(tempDir, tempDir);
	if (symlinkPath) {
		return [
			{
				type: 'SYMLINK_FOUND',
				message: `Repository contains a symbolic link: "${symlinkPath}". Symlinks are not allowed for security reasons.`,
			},
		];
	}

	const manifestPath = join(tempDir, 'manifest.yaml');

	let manifestSize: number;
	try {
		const manifestStat = await stat(manifestPath);
		manifestSize = manifestStat.size;
	} catch {
		return [
			{
				type: 'INVALID_MANIFEST',
				message: 'No manifest.yaml found in repository root.',
			},
		];
	}

	if (manifestSize > MAX_MANIFEST_SIZE) {
		return [
			{
				type: 'INVALID_MANIFEST',
				message: `manifest.yaml is too large (${manifestSize} bytes, max ${MAX_MANIFEST_SIZE}).`,
			},
		];
	}

	const manifestRaw = await readFile(manifestPath, 'utf-8');

	let manifestData: unknown;
	try {
		manifestData = parseYaml<unknown>(manifestRaw);
	} catch {
		return [{ type: 'INVALID_MANIFEST', message: 'manifest.yaml contains invalid YAML.' }];
	}

	const validation = validateManifest(manifestData);
	if (!validation.valid) {
		return [
			{
				type: 'INVALID_MANIFEST',
				message: 'Manifest validation failed.',
				details: validation.errors.join('\n'),
			},
		];
	}

	const manifest = validation.manifest;
	const appId = manifest.app.id;

	if (!APP_ID_PATTERN.test(appId)) {
		return [{ type: 'INVALID_MANIFEST', message: `Invalid app ID "${appId}".` }];
	}

	if (RESERVED_IDS.has(appId)) {
		return [
			{
				type: 'INVALID_MANIFEST',
				message: `App ID "${appId}" is reserved by the infrastructure.`,
			},
		];
	}

	const targetDir = join(options.appsDir, appId);
	try {
		await stat(targetDir);
		return [
			{
				type: 'ALREADY_INSTALLED',
				message: `App "${appId}" is already installed at ${targetDir}. Use \`pnpm uninstall-app ${appId}\` first, then reinstall.`,
			},
		];
	} catch {
		// Directory doesn't exist — good, we can proceed
	}

	const pasVersion = manifest.app.pas_core_version;
	if (pasVersion) {
		const compat = checkCompatibility(pasVersion, options.coreVersion);
		if (!compat.compatible) {
			return [
				{
					type: 'INCOMPATIBLE',
					message: compat.message ?? 'Incompatible CoreServices version.',
				},
			];
		}
	}

	const analysis = await analyzeApp(tempDir);
	if (analysis.violations.length > 0) {
		return analysis.violations.map((violation) => ({
			type: 'BANNED_IMPORT' as const,
			message: `${violation.file}:${violation.line} imports '${violation.importName}' directly.`,
			details: violation.reason,
		}));
	}

	return {
		tempDir,
		appId,
		targetDir,
		permissionSummary: buildPermissionSummary(manifest),
		appsDir: options.appsDir,
	};
}

function createPreparedInstall(plan: PreparedPlanData): PreparedInstall {
	let disposed = false;
	let commitPromise: Promise<InstallResult> | null = null;

	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		try {
			await rm(plan.tempDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup — callers should not fail if temp cleanup races or is redundant.
		}
	};

	const commit = async (): Promise<InstallResult> => {
		if (commitPromise) {
			return commitPromise;
		}

		commitPromise = (async () => {
			if (disposed) {
				return {
					success: false,
					appId: plan.appId,
					errors: [
						{
							type: 'INVALID_STATE',
							message: `Installation plan for "${plan.appId}" has already been disposed.`,
						},
					],
					permissionSummary: plan.permissionSummary,
				};
			}

			try {
				await cp(plan.tempDir, plan.targetDir, { recursive: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					success: false,
					appId: plan.appId,
					errors: [
						{
							type: 'COPY_FAILED',
							message: 'Failed to copy app to apps/ directory.',
							details: message,
						},
					],
					permissionSummary: plan.permissionSummary,
				};
			}

			try {
				const workspaceRoot = join(plan.appsDir, '..');
				await execFile('pnpm', ['install'], { cwd: workspaceRoot, timeout: 120_000 });
			} catch (err) {
				try {
					await rm(plan.targetDir, { recursive: true, force: true });
				} catch {
					// Best effort cleanup of partial install
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					success: false,
					appId: plan.appId,
					errors: [
						{
							type: 'INSTALL_DEPS_FAILED',
							message: 'Failed to install dependencies.',
							details: message,
						},
					],
					permissionSummary: plan.permissionSummary,
				};
			}

			return {
				success: true,
				appId: plan.appId,
				errors: [],
				permissionSummary: plan.permissionSummary,
			};
		})();

		return commitPromise;
	};

	return {
		appId: plan.appId,
		permissionSummary: plan.permissionSummary,
		commit,
		dispose,
	};
}

/**
 * Clone and validate an app installation without mutating apps/ or running pnpm install.
 * The returned PreparedInstall must be disposed by the caller.
 */
export async function planInstallApp(options: InstallOptions): Promise<PlanInstallResult> {
	const urlError = validateGitUrl(options.gitUrl);
	if (urlError) {
		return { success: false, errors: [urlError] };
	}

	let tempDir: string;
	try {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-install-'));
	} catch (err) {
		return {
			success: false,
			errors: [
				{ type: 'CLONE_FAILED', message: 'Failed to create temp directory.', details: String(err) },
			],
		};
	}

	let prepared: PreparedInstall | null = null;
	try {
		const cloneError = await cloneRepository(options.gitUrl, tempDir);
		if (cloneError) {
			return { success: false, errors: [cloneError] };
		}

		const validated = await validatePreparedInstall(options, tempDir);
		if (Array.isArray(validated)) {
			return { success: false, errors: validated };
		}

		prepared = createPreparedInstall(validated);
		return {
			success: true,
			appId: prepared.appId,
			errors: [],
			permissionSummary: prepared.permissionSummary,
			preparedInstall: prepared,
		};
	} finally {
		if (!prepared) {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch {
				// Best effort cleanup when planning does not succeed.
			}
		}
	}
}

/**
 * Backward-compatible one-shot installer wrapper.
 * Plans, commits, and always disposes the prepared install handle.
 */
export async function installApp(options: InstallOptions): Promise<InstallResult> {
	const planned = await planInstallApp(options);
	if (!planned.success || !planned.preparedInstall) {
		return {
			success: false,
			appId: planned.appId,
			errors: planned.errors,
			permissionSummary: planned.permissionSummary,
		};
	}

	try {
		return await planned.preparedInstall.commit();
	} finally {
		await planned.preparedInstall.dispose();
	}
}
