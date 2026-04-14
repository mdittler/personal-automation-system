/**
 * Data browser route.
 *
 * GET /gui/data — overview of all data directories (users, system).
 * GET /gui/data/browse — htmx partial returning file listing for a directory.
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import {
	ARCHIVE_FILENAME_PATTERN,
	MODEL_SLUG_PATTERN,
} from '../../services/model-journal/index.js';
import type { SystemConfig } from '../../types/config.js';

export interface DataOptions {
	config: SystemConfig;
	dataDir: string;
	logger: Logger;
}

/** Pattern for valid userId and appId segments. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

interface FileEntry {
	name: string;
	isDirectory: boolean;
	size: number;
	modified: string;
}

/**
 * List files in a directory, returning metadata for each entry.
 * Returns empty array if directory doesn't exist.
 */
async function listDirectory(dirPath: string): Promise<FileEntry[]> {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		const results: FileEntry[] = [];

		for (const entry of entries) {
			const fullPath = join(dirPath, entry.name);
			try {
				const stats = await lstat(fullPath);
				if (stats.isSymbolicLink()) continue; // skip symlinks

				results.push({
					name: entry.name,
					isDirectory: entry.isDirectory(),
					size: stats.size,
					modified: stats.mtime.toISOString().replace('T', ' ').slice(0, 19),
				});
			} catch {
				// Skip entries we can't stat
			}
		}

		// Sort: directories first, then alphabetical
		results.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return results;
	} catch {
		return [];
	}
}

/** Format file size in human-readable form. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Validate and resolve a browsing path. Returns null if path is invalid.
 */
function resolveBrowsePath(
	dataDir: string,
	scope: string,
	userId?: string,
	appId?: string,
	subpath?: string,
): string | null {
	// Validate segments
	if (userId && !SAFE_SEGMENT.test(userId)) return null;
	if (appId && !SAFE_SEGMENT.test(appId)) return null;

	// Build base path
	let targetPath: string;
	if (scope === 'user' && userId) {
		targetPath = appId ? join(dataDir, 'users', userId, appId) : join(dataDir, 'users', userId);
	} else if (scope === 'shared') {
		targetPath = appId ? join(dataDir, 'users', 'shared', appId) : join(dataDir, 'users', 'shared');
	} else if (scope === 'system') {
		targetPath = join(dataDir, 'system');
	} else if (scope === 'space' && userId) {
		// For spaces, userId parameter carries the spaceId
		targetPath = appId ? join(dataDir, 'spaces', userId, appId) : join(dataDir, 'spaces', userId);
	} else {
		return null;
	}

	// Handle subpath
	if (subpath) {
		// Reject absolute paths and traversal
		if (subpath.startsWith('/') || subpath.startsWith('\\')) return null;
		const normalizedSub = normalize(subpath);
		if (normalizedSub.includes('..')) return null;

		targetPath = join(targetPath, normalizedSub);
	}

	// Final safety check: resolved path must be within dataDir
	const resolvedTarget = resolve(targetPath);
	const resolvedData = resolve(dataDir);
	if (!resolvedTarget.startsWith(resolvedData)) return null;

	return targetPath;
}

export function registerDataRoutes(server: FastifyInstance, options: DataOptions): void {
	const { config, dataDir } = options;

	// Full page — overview of all data directories
	server.get('/data', async (_request: FastifyRequest, reply: FastifyReply) => {
		// Build user sections
		const userSections: Array<{
			id: string;
			name: string;
			apps: string[];
		}> = [];

		for (const user of config.users) {
			const userDir = join(dataDir, 'users', user.id);
			const apps = await listDirectory(userDir);
			userSections.push({
				id: user.id,
				name: user.name,
				apps: apps.filter((e) => e.isDirectory).map((e) => e.name),
			});
		}

		// Shared data
		const sharedDir = join(dataDir, 'users', 'shared');
		const sharedApps = await listDirectory(sharedDir);

		// System data
		const systemDir = join(dataDir, 'system');
		const systemEntries = await listDirectory(systemDir);

		// Space data
		const spacesDir = join(dataDir, 'spaces');
		const spaceEntries = await listDirectory(spacesDir);
		const spaceSections = spaceEntries
			.filter((e) => e.isDirectory && SAFE_SEGMENT.test(e.name))
			.map((e) => e.name);

		// Vault paths for Obsidian
		const vaultPaths = config.users.map((user) => ({
			name: user.name,
			path: resolve(join(dataDir, 'vaults', user.id)),
		}));

		return reply.viewAsync('data', {
			title: 'Data — PAS',
			activePage: 'data',
			userSections,
			sharedApps: sharedApps.filter((e) => e.isDirectory).map((e) => e.name),
			systemEntries: systemEntries.map((e) => ({ name: e.name, isDirectory: e.isDirectory })),
			spaceSections,
			vaultPaths,
			dataDir: resolve(dataDir),
		});
	});

	// htmx partial — file listing for a specific directory
	server.get('/data/browse', async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as {
			scope?: string;
			userId?: string;
			appId?: string;
			subpath?: string;
		};

		const { scope, userId, appId, subpath } = query;

		if (!scope) {
			return reply.status(400).type('text/html').send('Missing scope parameter.');
		}

		const targetPath = resolveBrowsePath(dataDir, scope, userId, appId, subpath);
		if (targetPath === null) {
			return reply.status(400).type('text/html').send('Invalid path.');
		}

		const entries = await listDirectory(targetPath);

		// Build breadcrumb label
		const breadcrumbParts: string[] = [];
		if (scope === 'user' && userId) {
			const user = config.users.find((u) => u.id === userId);
			breadcrumbParts.push(user ? `${user.name} (${userId})` : userId);
			if (appId) breadcrumbParts.push(appId);
		} else if (scope === 'shared') {
			breadcrumbParts.push('Shared');
			if (appId) breadcrumbParts.push(appId);
		} else if (scope === 'system') {
			breadcrumbParts.push('System');
		} else if (scope === 'space' && userId) {
			breadcrumbParts.push(`Space: ${userId}`);
			if (appId) breadcrumbParts.push(appId);
		}
		if (subpath) breadcrumbParts.push(subpath);
		const breadcrumb = `<tr><td colspan="3" style="padding:0.25rem 0.5rem;"><small><strong>${breadcrumbParts.map((p) => escapeHtml(p)).join(' / ')}</strong></small></td></tr>`;

		if (entries.length === 0) {
			return reply
				.type('text/html')
				.send(`${breadcrumb}<tr><td colspan="3"><em>No files found.</em></td></tr>`);
		}

		// Build browse URL params for sub-directories
		const baseParams = `scope=${escapeHtml(scope)}${userId ? `&userId=${escapeHtml(userId)}` : ''}${appId ? `&appId=${escapeHtml(appId)}` : ''}`;

		const rows = entries
			.map((e) => {
				const icon = e.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}';
				const sizeStr = e.isDirectory ? '\u2014' : formatSize(e.size);

				let nameCell: string;
				if (e.isDirectory) {
					const newSubpath = subpath ? `${subpath}/${e.name}` : e.name;
					nameCell = `<a href="#" hx-get="/gui/data/browse?${baseParams}&subpath=${encodeURIComponent(newSubpath)}" hx-target="#file-listing" hx-swap="innerHTML" style="cursor:pointer">${icon} ${escapeHtml(e.name)}/</a>`;
				} else {
					const filePath = subpath ? `${subpath}/${e.name}` : e.name;
					nameCell = `<a href="#" hx-get="/gui/data/view?${baseParams}&subpath=${encodeURIComponent(filePath)}" hx-target="#file-viewer" hx-swap="innerHTML" style="cursor:pointer">${icon} ${escapeHtml(e.name)}</a>`;
				}

				return `<tr><td>${nameCell}</td><td><small>${escapeHtml(sizeStr)}</small></td><td><small>${escapeHtml(e.modified)}</small></td></tr>`;
			})
			.join('\n');

		return reply.type('text/html').send(breadcrumb + rows);
	});

	// htmx partial — view file contents
	const MAX_FILE_SIZE = 512 * 1024; // 512KB cap

	server.get('/data/view', async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as {
			scope?: string;
			userId?: string;
			appId?: string;
			subpath?: string;
		};

		const { scope, userId, appId, subpath } = query;

		if (!scope || !subpath) {
			return reply.status(400).type('text/html').send('Missing parameters.');
		}

		const targetPath = resolveBrowsePath(dataDir, scope, userId, appId, subpath);
		if (targetPath === null) {
			return reply.status(400).type('text/html').send('Invalid path.');
		}

		try {
			const stats = await lstat(targetPath);
			if (stats.isSymbolicLink() || stats.isDirectory()) {
				return reply.status(400).type('text/html').send('Cannot view this entry.');
			}
			if (stats.size > MAX_FILE_SIZE) {
				return reply
					.type('text/html')
					.send(
						`<p><em>File too large to display (${formatSize(stats.size)}). Maximum: ${formatSize(MAX_FILE_SIZE)}.</em></p>`,
					);
			}

			const content = await readFile(targetPath, 'utf-8');
			const fileName = escapeHtml(subpath.split('/').pop() ?? '');
			const escapedContent = escapeHtml(content);

			const html = `<div style="margin-bottom:0.5rem;display:flex;justify-content:space-between;align-items:center;"><strong>${fileName}</strong> <small>${formatSize(stats.size)}</small></div><pre style="max-height:70vh;overflow:auto;padding:1rem;background:var(--pico-code-background-color,#1a1a2e);border-radius:4px;white-space:pre-wrap;word-wrap:break-word;"><code>${escapedContent}</code></pre>`;

			return reply.type('text/html').send(html);
		} catch {
			return reply.type('text/html').send('<p><em>Could not read file.</em></p>');
		}
	});

	// htmx partial — file picker for alert/report data source path fields
	server.get('/data/files', async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as {
			scope?: string;
			userId?: string;
			appId?: string;
			subpath?: string;
			target?: string;
		};

		const { scope, userId, appId, subpath, target } = query;

		if (!scope || !target) {
			return reply.status(400).type('text/html').send('<small>Missing parameters.</small>');
		}

		if (!/^[A-Za-z0-9_-]+$/.test(target)) {
			return reply.status(400).type('text/html').send('<small>Invalid target parameter.</small>');
		}

		if (!userId || !appId) {
			return reply.type('text/html').send('<small><em>Select an app and user first.</em></small>');
		}

		const targetPath = resolveBrowsePath(dataDir, scope, userId, appId, subpath);
		if (targetPath === null) {
			return reply.status(400).type('text/html').send('<small>Invalid path.</small>');
		}

		const entries = await listDirectory(targetPath);
		if (entries.length === 0) {
			return reply.type('text/html').send('<small><em>No files found.</em></small>');
		}

		const safeTarget = escapeHtml(target);
		const urlTarget = encodeURIComponent(target);
		const escapedScope = escapeHtml(scope);
		const escapedUserId = escapeHtml(userId);
		const escapedAppId = escapeHtml(appId);

		let html =
			'<div class="file-browser-list" style="max-height:180px;overflow-y:auto;border:1px solid var(--pas-border);border-radius:4px;padding:0.5rem;margin-top:0.25rem;">';

		// Back link for subdirectories
		if (subpath) {
			const parentPath = subpath.includes('/') ? subpath.slice(0, subpath.lastIndexOf('/')) : '';
			const parentParam = parentPath ? `&subpath=${encodeURIComponent(parentPath)}` : '';
			html += `<div><a href="#" style="text-decoration:none" hx-get="/gui/data/files?scope=${escapedScope}&userId=${escapedUserId}&appId=${escapedAppId}${parentParam}&target=${urlTarget}" hx-target="closest .file-browser-list" hx-swap="outerHTML">\u2190 Back</a></div>`;
		}

		for (const entry of entries) {
			const escapedName = escapeHtml(entry.name);
			const fullPath = subpath ? `${subpath}/${entry.name}` : entry.name;
			const escapedFullPath = escapeHtml(fullPath);

			if (entry.isDirectory) {
				html += `<div style="display:flex;align-items:center;gap:0.5rem"><a href="#" style="text-decoration:none;flex:1" hx-get="/gui/data/files?scope=${escapedScope}&userId=${escapedUserId}&appId=${escapedAppId}&subpath=${encodeURIComponent(fullPath)}&target=${urlTarget}" hx-target="closest .file-browser-list" hx-swap="outerHTML">\uD83D\uDCC1 ${escapedName}/</a><a href="#" style="text-decoration:none;font-size:0.75rem;padding:0.1rem 0.4rem;border:1px solid var(--pas-border);border-radius:4px" data-pick-path="${escapedFullPath}/" data-pick-target="${safeTarget}">Select</a></div>`;
			} else {
				html += `<div><a href="#" style="text-decoration:none" data-pick-path="${escapedFullPath}" data-pick-target="${safeTarget}">\uD83D\uDCC4 ${escapedName}</a> <small>${formatSize(entry.size)}</small></div>`;
			}
		}

		// Close button
		html +=
			'<div style="margin-top:0.25rem;border-top:1px solid var(--pas-border);padding-top:0.25rem;"><a href="#" style="text-decoration:none;font-size:0.8rem" data-close-browser>Close</a></div>';
		html += '</div>';

		return reply.type('text/html').send(html);
	});

	// htmx partial — model journal discovery (lists all model journals)

	server.get('/data/journal', async (_request: FastifyRequest, reply: FastifyReply) => {
		const journalDir = join(dataDir, 'model-journal');

		let slugs: string[] = [];
		try {
			const entries = await readdir(journalDir);
			slugs = entries
				.filter((name) => name.endsWith('.md'))
				.map((name) => name.slice(0, -3))
				.filter((slug) => MODEL_SLUG_PATTERN.test(slug))
				.sort();
		} catch {
			// Directory doesn't exist yet
		}

		if (slugs.length === 0) {
			return reply.type('text/html').send('<p><em>No journal entries yet.</em></p>');
		}

		let html = '';
		for (const slug of slugs) {
			html += `<details style="margin-bottom:0.5rem;"><summary><strong>${escapeHtml(slug)}</strong></summary><div hx-get="/gui/data/journal/model?slug=${encodeURIComponent(slug)}" hx-trigger="toggle from:closest details" hx-swap="innerHTML"><p><em>Loading...</em></p></div></details>`;
		}

		return reply.type('text/html').send(html);
	});

	// htmx partial — view a specific model's journal content + archives
	server.get('/data/journal/model', async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as { slug?: string };
		const slug = query.slug;

		if (!slug || !MODEL_SLUG_PATTERN.test(slug)) {
			return reply.status(400).type('text/html').send('Invalid model slug.');
		}

		const journalPath = join(dataDir, 'model-journal', `${slug}.md`);
		const archiveDir = join(dataDir, 'model-journal-archive', slug);

		let journalContent = '';
		try {
			journalContent = await readFile(journalPath, 'utf-8');
		} catch {
			// File doesn't exist yet
		}

		// List archives for this model
		let archiveFiles: string[] = [];
		try {
			const entries = await readdir(archiveDir);
			archiveFiles = entries
				.filter((name) => ARCHIVE_FILENAME_PATTERN.test(name))
				.sort()
				.reverse();
		} catch {
			// No archive directory yet
		}

		let html = '';
		if (journalContent) {
			html += `<pre style="max-height:50vh;overflow:auto;padding:1rem;background:var(--pico-code-background-color,#1a1a2e);border-radius:4px;white-space:pre-wrap;word-wrap:break-word;"><code>${escapeHtml(journalContent)}</code></pre>`;
		} else {
			html += '<p><em>No entries yet.</em></p>';
		}

		if (archiveFiles.length > 0) {
			html +=
				'<details style="margin-top:0.5rem;"><summary><small>Archived journals</small></summary><ul style="list-style:none;padding-left:0.5rem;">';
			for (const file of archiveFiles) {
				const label = escapeHtml(file.replace('.md', ''));
				html += `<li><a href="#" hx-get="/gui/data/journal/archive?slug=${encodeURIComponent(slug)}&file=${encodeURIComponent(file)}" hx-target="#journal-content" hx-swap="innerHTML" style="font-size:0.9rem">${label}</a></li>`;
			}
			html += '</ul></details>';
		}

		return reply.type('text/html').send(html);
	});

	// htmx partial — view archived journal for a specific model
	server.get('/data/journal/archive', async (request: FastifyRequest, reply: FastifyReply) => {
		const query = request.query as { slug?: string; file?: string };
		const { slug, file } = query;

		if (!slug || !MODEL_SLUG_PATTERN.test(slug)) {
			return reply.status(400).type('text/html').send('Invalid model slug.');
		}

		if (!file || !ARCHIVE_FILENAME_PATTERN.test(file)) {
			return reply.status(400).type('text/html').send('Invalid archive file.');
		}

		try {
			const archivePath = join(dataDir, 'model-journal-archive', slug, file);
			// Safety: verify resolved path is within dataDir
			const resolvedArchive = resolve(archivePath);
			const resolvedData = resolve(dataDir);
			if (!resolvedArchive.startsWith(resolvedData)) {
				return reply.status(400).type('text/html').send('Invalid path.');
			}

			const content = await readFile(archivePath, 'utf-8');
			const html =
				`<div style="margin-bottom:0.5rem;"><small><a href="#" hx-get="/gui/data/journal/model?slug=${encodeURIComponent(slug)}" hx-target="#journal-content" hx-swap="innerHTML">\u2190 Back to ${escapeHtml(slug)}</a> | Archive: <strong>${escapeHtml(slug)} / ${escapeHtml(file.replace('.md', ''))}</strong></small></div>` +
				`<pre style="max-height:50vh;overflow:auto;padding:1rem;background:var(--pico-code-background-color,#1a1a2e);border-radius:4px;white-space:pre-wrap;word-wrap:break-word;"><code>${escapeHtml(content)}</code></pre>`;

			return reply.type('text/html').send(html);
		} catch {
			return reply.type('text/html').send('<p><em>Archive not found.</em></p>');
		}
	});
}
