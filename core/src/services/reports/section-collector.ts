/**
 * Section data collector for reports.
 *
 * Dispatches to per-type data gatherers. Each section type reads from
 * a different data source and returns markdown-formatted content.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type { ContextStoreService } from '../../types/context-store.js';
import type {
	AppDataSectionConfig,
	ChangesSectionConfig,
	CollectedSection,
	ContextSectionConfig,
	CustomSectionConfig,
	ReportSection,
} from '../../types/report.js';
import { DEFAULT_LOOKBACK_HOURS } from '../../types/report.js';
import { stripFrontmatter } from '../../utils/frontmatter.js';
import { collectChanges } from '../daily-diff/collector.js';
import type { ChangeLog } from '../data-store/change-log.js';

export interface CollectorDeps {
	changeLog: ChangeLog;
	dataDir: string;
	contextStore: ContextStoreService;
	timezone: string;
	logger: Logger;
	/**
	 * Household ID of the report owner. When set, any resolved file path that
	 * falls under a `households/<hh>/` subtree is checked to ensure `<hh>`
	 * matches this value. Paths outside `households/` are passed through
	 * unchanged (fail-open for non-migrated instances).
	 */
	householdId?: string;
}

/**
 * Collect data for a single report section.
 */
export async function collectSection(
	section: ReportSection,
	deps: CollectorDeps,
): Promise<CollectedSection> {
	try {
		switch (section.type) {
			case 'changes':
				return await collectChangesSection(
					section.label,
					section.config as ChangesSectionConfig,
					deps,
				);
			case 'app-data':
				return await collectAppDataSection(
					section.label,
					section.config as AppDataSectionConfig,
					deps,
				);
			case 'context':
				return await collectContextSection(
					section.label,
					section.config as ContextSectionConfig,
					deps,
				);
			case 'custom':
				return collectCustomSection(section.label, section.config as CustomSectionConfig);
			default:
				return {
					label: section.label,
					content: `Unknown section type: ${section.type}`,
					isEmpty: true,
				};
		}
	} catch (error) {
		deps.logger.error(
			{ error, sectionType: section.type, label: section.label },
			'Failed to collect section data',
		);
		return {
			label: section.label,
			content: 'Error collecting data for this section.',
			isEmpty: true,
		};
	}
}

async function collectChangesSection(
	label: string,
	config: ChangesSectionConfig,
	deps: CollectorDeps,
): Promise<CollectedSection> {
	const lookbackHours = config.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
	const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

	const changes = await collectChanges(deps.changeLog.getLogPath(), since);

	if (changes.entries.length === 0) {
		return { label, content: 'No changes in this period.', isEmpty: true };
	}

	// Apply app filter if specified
	const appFilter = config.app_filter?.length ? new Set(config.app_filter) : null;

	const lines: string[] = [];
	for (const [appId, users] of Object.entries(changes.byApp)) {
		if (appFilter && !appFilter.has(appId)) continue;

		lines.push(`**${appId}**`);
		for (const [userId, entries] of Object.entries(users)) {
			const ops = entries.map((e) => `${e.operation} \`${e.path}\``).join(', ');
			lines.push(`- User ${userId}: ${ops}`);
		}
	}

	if (lines.length === 0) {
		return { label, content: 'No changes matching filter.', isEmpty: true };
	}

	return { label, content: lines.join('\n'), isEmpty: false };
}

async function collectAppDataSection(
	label: string,
	config: AppDataSectionConfig,
	deps: CollectorDeps,
): Promise<CollectedSection> {
	// Resolve date tokens in path
	const resolvedPath = resolveDateTokens(config.path, deps.timezone);

	// Build the full path: space-aware or per-user (household-aware post-migration)
	// biome-ignore lint/style/noNonNullAssertion: validated by report-validator (user_id required when no space_id)
	const baseDir = config.space_id
		? resolve(join(deps.dataDir, 'spaces', config.space_id, config.app_id))
		: deps.householdId
			? resolve(join(deps.dataDir, 'households', deps.householdId, 'users', config.user_id!, config.app_id))
			: resolve(join(deps.dataDir, 'users', config.user_id!, config.app_id));
	const fullPath = resolve(join(baseDir, resolvedPath));

	// Path traversal check: ensure resolved path is within the base dir
	// Use baseDir + separator to prevent prefix matching (e.g., notes-evil matching notes)
	if (!fullPath.startsWith(baseDir + sep)) {
		deps.logger.warn(
			{ path: config.path, resolved: fullPath },
			'Path traversal attempt in app-data section',
		);
		return { label, content: 'Invalid path.', isEmpty: true };
	}

	// Household boundary check: if the resolved path is under households/<hh>/, verify
	// it belongs to the report owner's household. Fail-open when householdId is absent
	// (system call or pre-migration instance).
	if (deps.householdId) {
		const householdMatch = /[/\\]households[/\\]([^/\\]+)[/\\]/.exec(fullPath);
		if (householdMatch) {
			const pathHouseholdId = householdMatch[1];
			if (pathHouseholdId !== deps.householdId) {
				deps.logger.warn(
					{ pathHouseholdId, reportHouseholdId: deps.householdId, resolved: fullPath },
					'Household boundary violation in app-data section — skipping',
				);
				return { label, content: 'Access denied.', isEmpty: true };
			}
		}
	}

	try {
		const pathStats = await stat(fullPath);

		if (pathStats.isDirectory()) {
			const content = await readMostRecentFile(fullPath);
			return { label, content: content.trim(), isEmpty: !content.trim() };
		}

		const raw = await readFile(fullPath, 'utf-8');
		const content = stripFrontmatter(raw);
		return { label, content: content.trim(), isEmpty: !content.trim() };
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return { label, content: 'File not found.', isEmpty: true };
		}
		throw error;
	}
}

/**
 * Read the most recent file from a directory by modification time.
 */
async function readMostRecentFile(dirPath: string): Promise<string> {
	const entries = await readdir(dirPath, { withFileTypes: true });
	const files: Array<{ name: string; mtime: number }> = [];

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		try {
			const entryStats = await stat(join(dirPath, entry.name));
			files.push({ name: entry.name, mtime: entryStats.mtimeMs });
		} catch {
			// Skip entries we can't stat
		}
	}

	if (files.length === 0) return '';

	files.sort((a, b) => b.mtime - a.mtime);
	const raw = await readFile(join(dirPath, files[0]!.name), 'utf-8');
	return stripFrontmatter(raw);
}

async function collectContextSection(
	label: string,
	config: ContextSectionConfig,
	deps: CollectorDeps,
): Promise<CollectedSection> {
	const entries = await deps.contextStore.search(config.key_prefix);

	if (entries.length === 0) {
		return { label, content: 'No matching context entries.', isEmpty: true };
	}

	const lines = entries.map((entry) => `**${entry.key}**:\n${entry.content.trim()}`);
	return { label, content: lines.join('\n\n'), isEmpty: false };
}

function collectCustomSection(label: string, config: CustomSectionConfig): CollectedSection {
	const text = config.text?.trim() ?? '';
	return { label, content: text, isEmpty: !text };
}

/**
 * Resolve date tokens ({date}, {today}, {yesterday}) in a path string.
 * {date} is an alias for {today}.
 */
export function resolveDateTokens(path: string, timezone: string): string {
	const now = new Date();

	const todayStr = formatDate(now, timezone);
	const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const yesterdayStr = formatDate(yesterday, timezone);

	return path
		.replace(/\{date\}/g, todayStr)
		.replace(/\{today\}/g, todayStr)
		.replace(/\{yesterday\}/g, yesterdayStr);
}

function formatDate(date: Date, timezone: string): string {
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(date);

		const year = parts.find((p) => p.type === 'year')?.value;
		const month = parts.find((p) => p.type === 'month')?.value;
		const day = parts.find((p) => p.type === 'day')?.value;
		if (!year || !month || !day) {
			return date.toISOString().slice(0, 10);
		}
		return `${year}-${month}-${day}`;
	} catch {
		// Fallback to ISO date
		return date.toISOString().slice(0, 10);
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
