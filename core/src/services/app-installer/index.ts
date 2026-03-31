/**
 * App installer for PAS.
 *
 * Orchestrates the full installation pipeline: clone, validate manifest,
 * check compatibility, run static analysis, copy to apps/, install deps.
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
		| 'INSTALL_DEPS_FAILED'
		| 'INVALID_GIT_URL'
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

/**
 * Install a PAS app from a git URL.
 *
 * Pipeline:
 * 1. Validate git URL
 * 2. Clone to temp directory
 * 3. Read and validate manifest
 * 4. Check if already installed
 * 5. Check CoreServices version compatibility
 * 6. Run static analysis for banned imports
 * 7. Build permission summary
 * 8. Copy to apps/<app-id>/
 * 9. Install dependencies
 */
export async function installApp(options: InstallOptions): Promise<InstallResult> {
	const { gitUrl, appsDir, coreVersion } = options;
	const errors: InstallError[] = [];

	// 1. Validate git URL
	const urlError = validateGitUrl(gitUrl);
	if (urlError) {
		return { success: false, errors: [urlError] };
	}

	// 2. Clone to temp directory
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

	try {
		try {
			await execFile('git', ['clone', '--depth', '1', gitUrl, tempDir], { timeout: 60_000 });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({ type: 'CLONE_FAILED', message: 'Git clone failed.', details: message });
			return { success: false, errors };
		}

		// 2b. Scan for symlinks (prevents symlink escape attacks)
		const symlinkPath = await findSymlinks(tempDir, tempDir);
		if (symlinkPath) {
			errors.push({
				type: 'SYMLINK_FOUND',
				message: `Repository contains a symbolic link: "${symlinkPath}". Symlinks are not allowed for security reasons.`,
			});
			return { success: false, errors };
		}

		// 3. Read and validate manifest
		const manifestPath = join(tempDir, 'manifest.yaml');
		const MAX_MANIFEST_SIZE = 1024 * 1024; // 1MB

		// Check manifest exists and size before reading (D29: YAML bomb protection)
		let manifestSize: number;
		try {
			const manifestStat = await stat(manifestPath);
			manifestSize = manifestStat.size;
		} catch {
			errors.push({
				type: 'INVALID_MANIFEST',
				message: 'No manifest.yaml found in repository root.',
			});
			return { success: false, errors };
		}

		if (manifestSize > MAX_MANIFEST_SIZE) {
			errors.push({
				type: 'INVALID_MANIFEST',
				message: `manifest.yaml is too large (${manifestSize} bytes, max ${MAX_MANIFEST_SIZE}).`,
			});
			return { success: false, errors };
		}

		const manifestRaw = await readFile(manifestPath, 'utf-8');

		let manifestData: unknown;
		try {
			manifestData = parseYaml<unknown>(manifestRaw);
		} catch {
			errors.push({ type: 'INVALID_MANIFEST', message: 'manifest.yaml contains invalid YAML.' });
			return { success: false, errors };
		}

		const validation = validateManifest(manifestData);
		if (!validation.valid) {
			errors.push({
				type: 'INVALID_MANIFEST',
				message: 'Manifest validation failed.',
				details: validation.errors.join('\n'),
			});
			return { success: false, errors };
		}

		const manifest = validation.manifest;
		const appId = manifest.app.id;

		// Validate app ID (defense-in-depth — schema already enforces this)
		if (!APP_ID_PATTERN.test(appId)) {
			errors.push({ type: 'INVALID_MANIFEST', message: `Invalid app ID "${appId}".` });
			return { success: false, errors };
		}

		if (RESERVED_IDS.has(appId)) {
			errors.push({
				type: 'INVALID_MANIFEST',
				message: `App ID "${appId}" is reserved by the infrastructure.`,
			});
			return { success: false, errors };
		}

		// 4. Check if already installed
		const targetDir = join(appsDir, appId);
		try {
			await stat(targetDir);
			errors.push({
				type: 'ALREADY_INSTALLED',
				message: `App "${appId}" is already installed at ${targetDir}. Use \`pnpm uninstall-app ${appId}\` first, then reinstall.`,
			});
			return { success: false, errors };
		} catch {
			// Directory doesn't exist — good, we can proceed
		}

		// 5. Check compatibility
		const pasVersion = manifest.app.pas_core_version;
		if (pasVersion) {
			const compat = checkCompatibility(pasVersion, coreVersion);
			if (!compat.compatible) {
				errors.push({
					type: 'INCOMPATIBLE',
					message: compat.message ?? 'Incompatible CoreServices version.',
				});
				return { success: false, errors };
			}
		}

		// 6. Static analysis
		const analysis = await analyzeApp(tempDir);
		if (analysis.violations.length > 0) {
			for (const v of analysis.violations) {
				errors.push({
					type: 'BANNED_IMPORT',
					message: `${v.file}:${v.line} imports '${v.importName}' directly.`,
					details: v.reason,
				});
			}
			return { success: false, errors };
		}

		// 7. Build permission summary
		const permissionSummary = buildPermissionSummary(manifest);

		// 8. Copy to apps/<app-id>/
		try {
			await cp(tempDir, targetDir, { recursive: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({
				type: 'CLONE_FAILED',
				message: 'Failed to copy app to apps/ directory.',
				details: message,
			});
			return { success: false, errors };
		}

		// 9. Install dependencies (from workspace root, pnpm will pick up the new package)
		try {
			const workspaceRoot = join(appsDir, '..');
			await execFile('pnpm', ['install'], { cwd: workspaceRoot, timeout: 120_000 });
		} catch (err) {
			// Clean up the target directory since deps failed
			try {
				await rm(targetDir, { recursive: true, force: true });
			} catch {
				// Best effort cleanup
			}
			const message = err instanceof Error ? err.message : String(err);
			errors.push({
				type: 'INSTALL_DEPS_FAILED',
				message: 'Failed to install dependencies.',
				details: message,
			});
			return { success: false, errors };
		}

		return {
			success: true,
			appId,
			errors: [],
			permissionSummary,
		};
	} finally {
		// Clean up temp directory
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	}
}
