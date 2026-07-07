/**
 * Activity feed (Batch 6, Task 6.3).
 *
 * `/gui/activity` — daily change digest built from `collectChanges` over
 * the JSONL change log. Scoped per-caller:
 *   - Platform admins see every entry.
 *   - Members see only entries where `entry.userId` is them (their own
 *     per-user-scoped writes), household-shared writes (`userId === 'system'`,
 *     no `spaceId`, `householdId` matches theirs), or writes to a space they
 *     belong to (`spaceId` in their memberships via SpaceService).
 *
 * Entries are humanized (app + file basename + verb) — never a full path —
 * and grouped by day, newest first.
 */
import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { collectChanges } from '../../services/daily-diff/collector.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { ChangeLogEntry } from '../../types/data-store.js';

export interface ActivityRoutesOptions {
	/** Absolute path to the change-log JSONL file (ChangeLog.getLogPath()). */
	logPath: string;
	householdService: Pick<HouseholdService, 'getHouseholdForUser'>;
	spaceService: Pick<SpaceService, 'getSpacesForUser'>;
	logger: Logger;
}

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

/**
 * Full "was/had ..." clause per operation — NOT a bare verb — so the
 * template can render "{file} {verb}" as a complete, natural sentence.
 * `append` previously mapped to the bare verb "added to", which combined
 * with the template's fixed "{file} was {verb}" produced the dangling
 * "log.md was added to" (C4 fix).
 */
const VERB_BY_OPERATION: Record<ChangeLogEntry['operation'], string> = {
	write: 'was updated',
	append: 'had items added',
	archive: 'was archived',
	read: 'was viewed',
};

interface HumanizedEntry {
	app: string;
	file: string;
	verb: string;
	timestamp: string;
}

function humanizeEntry(entry: ChangeLogEntry): HumanizedEntry {
	return {
		app: entry.appId,
		file: basename(entry.path),
		verb: VERB_BY_OPERATION[entry.operation] ?? 'was changed',
		timestamp: entry.timestamp,
	};
}

function isVisibleToMember(
	entry: ChangeLogEntry,
	userId: string,
	householdId: string | null,
	memberSpaceIds: Set<string>,
): boolean {
	// Own per-user-scoped writes.
	if (entry.userId === userId) return true;
	// Space writes — visible if the member belongs to that space.
	if (entry.spaceId) return memberSpaceIds.has(entry.spaceId);
	// Household-shared writes (forShared(), userId recorded as 'system', no spaceId).
	if (entry.userId === 'system') {
		return householdId !== null && entry.householdId === householdId;
	}
	return false;
}

function clampDays(raw: string | undefined): number {
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	if (Number.isNaN(n)) return DEFAULT_DAYS;
	return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

export function registerActivityRoutes(
	server: FastifyInstance,
	options: ActivityRoutesOptions,
): void {
	const { logPath, householdService, spaceService } = options;

	server.get('/activity', async (request: FastifyRequest, reply: FastifyReply) => {
		const actor = request.user;
		if (!actor) {
			return reply.status(403).viewAsync('403', { title: '403 Forbidden — PAS' });
		}

		const query = request.query as { days?: string };
		const days = clampDays(query.days);
		const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

		const changes = await collectChanges(logPath, since);

		let visibleEntries = changes.entries;
		if (!actor.isPlatformAdmin) {
			const householdId = householdService.getHouseholdForUser(actor.userId);
			const memberSpaceIds = new Set(spaceService.getSpacesForUser(actor.userId).map((s) => s.id));
			visibleEntries = changes.entries.filter((e) =>
				isVisibleToMember(e, actor.userId, householdId, memberSpaceIds),
			);
		}

		// Group by calendar day (YYYY-MM-DD from the ISO timestamp), newest first.
		const byDay = new Map<string, HumanizedEntry[]>();
		for (const entry of visibleEntries) {
			const day = entry.timestamp.slice(0, 10);
			const humanized = humanizeEntry(entry);
			const existing = byDay.get(day);
			if (existing) {
				existing.push(humanized);
			} else {
				byDay.set(day, [humanized]);
			}
		}
		const days_ = Array.from(byDay.entries())
			.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
			.map(([date, entries]) => ({
				date,
				entries: entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
			}));

		return reply.viewAsync('activity', {
			title: 'Activity — PAS',
			activePage: 'activity',
			days: days_,
			daysWindow: days,
		});
	});
}
