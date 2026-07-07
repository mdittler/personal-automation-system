/**
 * GUI runtime-verification harness (dev tool — NOT part of the production system).
 *
 * Starts the REAL PAS management GUI — real Fastify server, real service
 * instances, the real `registerGuiRoutes` from core/src/gui/index.ts, wired
 * via the real `composeRuntime()` — against a seeded temp data directory,
 * on http://127.0.0.1:3777. No Telegram polling, no LLM network calls, no
 * credentials needed. Use it to click through the GUI with realistic
 * multi-user, multi-household data, or as a target for scripted checks
 * (permissions matrices, data-flow tracing) via curl.
 *
 * Run with:
 *   pnpm exec tsx scripts/gui-verify-harness.ts
 * (or via .claude/launch.json config "gui-verify" for browser-preview tools)
 *
 * Full guide — seeded accounts, expected-numbers JSON, extension recipes:
 *   docs/GUI_VERIFY_HARNESS.md
 *
 * Seeded state is written fresh on every start; delete the printed data dir
 * to reset between runs. scripts/.gui-verify-expected.json (machine-readable
 * expected numbers for assertions) is a runtime artifact and stays untracked.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

import { composeRuntime } from '../core/src/compose-runtime.js';
import { createChatTranscriptIndex } from '../core/src/services/chat-transcript-index/index.js';
import { requestContext } from '../core/src/services/context/request-context.js';
import { CostTracker } from '../core/src/services/llm/cost-tracker.js';
import { fakeTelegramService } from '../core/src/testing/fixtures/fake-telegram.js';
import { createStubProviderRegistry } from '../core/src/testing/fixtures/stub-llm-provider.js';
import type { AlertDefinition } from '../core/src/types/alert.js';
import type { SystemConfig } from '../core/src/types/config.js';
import type { ReportDefinition } from '../core/src/types/report.js';
import type { RegisteredUser } from '../core/src/types/users.js';
import { generateFrontmatter } from '../core/src/utils/frontmatter.js';
import { writeYamlFile } from '../core/src/utils/yaml.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Constants — seeded identities
// ---------------------------------------------------------------------------

const PORT = 3777;
const HOST = '127.0.0.1';

const MATTHEW = { id: '1000001', name: 'Matthew', password: 'admin-pass-1' };
const SAM = { id: '1000002', name: 'Sam', password: 'member-pass-1' };
const RIVAL = { id: '1000003', name: 'Rival', password: 'rival-pass-1' };

const HH_MAIN = 'home-main';
const HH_OTHER = 'home-other';

function isoDaysAgo(days: number, hour = 12): string {
	const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}

function dateDaysAgo(days: number): string {
	return isoDaysAgo(days).slice(0, 10);
}

async function pickScratchDir(): Promise<string> {
	const candidate =
		'/private/tmp/claude-501/-Users-mdittler-Projects-personal-automation-system--claude-worktrees-infallible-chaum-723390/235d68c7-5d0b-45db-ad07-048dc6fcfdd3/scratchpad';
	try {
		await mkdir(candidate, { recursive: true });
		return join(candidate, 'pas-verify-data');
	} catch {
		return join(tmpdir(), 'pas-verify-data');
	}
}

// ---------------------------------------------------------------------------
// Seed: llm-usage.md
// ---------------------------------------------------------------------------

interface UsageRowSpec {
	timestamp: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	app: string;
	user: string;
	household?: string; // 9-col when present, 8-col when omitted
}

function formatUsageRow(r: UsageRowSpec): string {
	const cost = r.cost.toFixed(6);
	const cells = [
		r.timestamp,
		r.provider,
		r.model,
		r.inputTokens,
		r.outputTokens,
		cost,
		r.app,
		r.user,
	];
	if (r.household) cells.push(r.household);
	return `| ${cells.join(' | ')} |`;
}

/** Target monthly totals — exact, regardless of how many days fall in the current calendar month. */
const MATTHEW_MONTH_TARGET_USD = 3.2;
const SAM_MONTH_TARGET_USD = 0.9;

/**
 * Seed ~30 days of usage rows across Matthew/Sam, mixed 8/9-column formats,
 * food + chatbot apps. Rows are spread across the last 30 days (for a
 * realistic llm-daily chart), but only rows whose timestamp falls in the
 * CURRENT calendar month (UTC) count toward the monthly totals the GUI's
 * cost-tracker cache displays. Per-row costs for current-month rows are
 * scaled so the sum lands exactly on MATTHEW_MONTH_TARGET_USD /
 * SAM_MONTH_TARGET_USD — independent of which day-of-month "today" is.
 */
function buildUsageLog(): { content: string; matthewMonthTotal: number; samMonthTotal: number } {
	const header =
		'| Timestamp | Provider | Model | Input Tokens | Output Tokens | Cost ($) | App | User | Household |';
	const separator =
		'|-----------|----------|-------|-------------|---------------|----------|-----|------|-----------|';
	const rows: string[] = [];

	const now = new Date();
	const currentMonthPrefix = now.toISOString().slice(0, 7);

	// Base (unscaled) per-row cost shapes — same relative weighting as before,
	// used only to distribute the fixed monthly target proportionally across
	// the current-month rows.
	interface PlannedRow {
		daysAgo: number;
		hour: number;
		app: string;
		inputTokens: number;
		outputTokens: number;
		baseCost: number;
		household?: string;
	}

	const matthewRows: PlannedRow[] = [];
	const samRows: PlannedRow[] = [];

	for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
		matthewRows.push({
			daysAgo,
			hour: 9 + (daysAgo % 6),
			app: 'food',
			inputTokens: 800 + daysAgo * 3,
			outputTokens: 220 + daysAgo,
			baseCost: 0.07 + (daysAgo % 3) * 0.004,
			household: HH_MAIN, // 9-col
		});
		matthewRows.push({
			daysAgo,
			hour: 14,
			app: 'chatbot',
			inputTokens: 500 + daysAgo * 2,
			outputTokens: 150 + daysAgo,
			baseCost: 0.036 + (daysAgo % 2) * 0.003,
			// 8-col (no household) — exercises the mixed-schema parser path
		});
		if (daysAgo % 2 === 0) {
			samRows.push({
				daysAgo,
				hour: 18,
				app: 'chatbot',
				inputTokens: 300 + daysAgo,
				outputTokens: 90 + daysAgo,
				baseCost: 0.055 + (daysAgo % 4) * 0.002,
				household: HH_MAIN,
			});
		}
	}

	function isCurrentMonth(daysAgo: number, hour: number): boolean {
		return isoDaysAgo(daysAgo, hour).startsWith(currentMonthPrefix);
	}

	function scaleFactorFor(planned: PlannedRow[], targetUsd: number): number {
		const currentMonthBaseSum = planned
			.filter((r) => isCurrentMonth(r.daysAgo, r.hour))
			.reduce((sum, r) => sum + r.baseCost, 0);
		return currentMonthBaseSum > 0 ? targetUsd / currentMonthBaseSum : 0;
	}

	const matthewScale = scaleFactorFor(matthewRows, MATTHEW_MONTH_TARGET_USD);
	const samScale = scaleFactorFor(samRows, SAM_MONTH_TARGET_USD);

	let matthewMonthTotal = 0;
	let samMonthTotal = 0;

	for (const r of matthewRows) {
		const inMonth = isCurrentMonth(r.daysAgo, r.hour);
		const cost = round6(inMonth ? r.baseCost * matthewScale : r.baseCost);
		rows.push(
			formatUsageRow({
				timestamp: isoDaysAgo(r.daysAgo, r.hour),
				provider: 'stub',
				model: 'stub-model',
				inputTokens: r.inputTokens,
				outputTokens: r.outputTokens,
				cost,
				app: r.app,
				user: MATTHEW.id,
				household: r.household,
			}),
		);
		if (inMonth) matthewMonthTotal = round6(matthewMonthTotal + cost);
	}

	for (const r of samRows) {
		const inMonth = isCurrentMonth(r.daysAgo, r.hour);
		const cost = round6(inMonth ? r.baseCost * samScale : r.baseCost);
		rows.push(
			formatUsageRow({
				timestamp: isoDaysAgo(r.daysAgo, r.hour),
				provider: 'stub',
				model: 'stub-model',
				inputTokens: r.inputTokens,
				outputTokens: r.outputTokens,
				cost,
				app: r.app,
				user: SAM.id,
				household: r.household,
			}),
		);
		if (inMonth) samMonthTotal = round6(samMonthTotal + cost);
	}

	const content = [header, separator, ...rows, ''].join('\n');
	return { content, matthewMonthTotal, samMonthTotal };
}

function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Seed: change-log.jsonl
// ---------------------------------------------------------------------------

interface ChangeLogSeedEntry {
	timestamp: string;
	operation: 'read' | 'write' | 'append' | 'archive';
	path: string;
	appId: string;
	userId: string;
	spaceId?: string;
	householdId?: string;
}

function buildChangeLog(): { content: string; entries: ChangeLogSeedEntry[] } {
	const entries: ChangeLogSeedEntry[] = [
		// Matthew-private (day -1)
		{
			timestamp: isoDaysAgo(1, 8),
			operation: 'write',
			path: 'preferences.yaml',
			appId: 'food',
			userId: MATTHEW.id,
			householdId: HH_MAIN,
		},
		// Sam-private (day -2)
		{
			timestamp: isoDaysAgo(2, 9),
			operation: 'append',
			path: 'nutrition/log.md',
			appId: 'food',
			userId: SAM.id,
			householdId: HH_MAIN,
		},
		// Household-shared (userId='system', householdId=home-main) (day -2)
		{
			timestamp: isoDaysAgo(2, 15),
			operation: 'write',
			path: 'pantry.md',
			appId: 'food',
			userId: 'system',
			householdId: HH_MAIN,
		},
		// Space-scoped (meal-planning space, both Matthew+Sam are members) (day -3)
		{
			timestamp: isoDaysAgo(3, 10),
			operation: 'write',
			path: 'menu.md',
			appId: 'food',
			userId: MATTHEW.id,
			spaceId: 'meal-planning',
			householdId: HH_MAIN,
		},
		// home-other entry — must be invisible to home-main members (day -4)
		{
			timestamp: isoDaysAgo(4, 11),
			operation: 'write',
			path: 'pantry.md',
			appId: 'food',
			userId: 'system',
			householdId: HH_OTHER,
		},
		// A second Matthew-private entry on day -5, for multi-day grouping
		{
			timestamp: isoDaysAgo(5, 7),
			operation: 'archive',
			path: 'recipes/old-tacos.yaml',
			appId: 'food',
			userId: MATTHEW.id,
			householdId: HH_MAIN,
		},
	];

	const lines = entries.map((e) => JSON.stringify(e));
	return { content: `${lines.join('\n')}\n`, entries };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const scratchBase = await pickScratchDir();
	const tempDir = scratchBase;
	const dataDir = join(tempDir, 'data');
	const backupsDir = join(tempDir, 'backups');
	const configPath = join(tempDir, 'pas.yaml');

	console.log(`\n[gui-verify-harness] seed data dir: ${tempDir}\n`);

	await mkdir(join(dataDir, 'system'), { recursive: true });
	await mkdir(backupsDir, { recursive: true });

	// -------------------------------------------------------------------------
	// 1. Users + households + config
	// -------------------------------------------------------------------------

	const registeredUsers: RegisteredUser[] = [
		{
			id: MATTHEW.id,
			name: MATTHEW.name,
			isAdmin: true,
			enabledApps: ['*'],
			sharedScopes: [],
			householdId: HH_MAIN,
		},
		{
			id: SAM.id,
			name: SAM.name,
			isAdmin: false,
			enabledApps: ['*'],
			sharedScopes: [],
			householdId: HH_MAIN,
		},
		{
			id: RIVAL.id,
			name: RIVAL.name,
			isAdmin: false,
			enabledApps: ['*'],
			sharedScopes: [],
			householdId: HH_OTHER,
		},
	];

	const stubRef = { provider: 'stub', model: 'stub-model' };
	const config: SystemConfig = {
		port: PORT,
		dataDir,
		logLevel: 'silent',
		timezone: 'UTC',
		telegram: { botToken: 'gui-verify-stub-token' },
		claude: { apiKey: '', model: 'stub-model' },
		llm: {
			providers: {
				stub: {
					type: 'openai-compatible',
					name: 'Stub',
					apiKeyEnvVar: '',
					defaultModel: 'stub-model',
				},
			},
			tiers: { fast: stubRef, standard: stubRef, reasoning: stubRef },
		},
		gui: { authToken: 'gui-verify-legacy-token-unused' },
		api: { token: '' },
		cloudflare: {},
		webhooks: [],
		n8n: { dispatchUrl: '' },
		users: registeredUsers,
		backup: {
			enabled: true,
			path: backupsDir,
			schedule: '0 3 * * *',
			retentionCount: 7,
		},
	};

	await writeYamlFile(configPath, config);

	// households.yaml — write directly so IDs are exactly 'home-main' / 'home-other'
	// (HouseholdService slugifies createHousehold() names, so we hand-write the
	// file to pin the IDs the spec asked for instead of relying on slugification).
	const nowIso = new Date().toISOString();
	await writeYamlFile(join(dataDir, 'system', 'households.yaml'), {
		[HH_MAIN]: {
			id: HH_MAIN,
			name: 'Home Main',
			createdAt: nowIso,
			createdBy: MATTHEW.id,
			adminUserIds: [MATTHEW.id],
		},
		[HH_OTHER]: {
			id: HH_OTHER,
			name: 'Home Other',
			createdAt: nowIso,
			createdBy: RIVAL.id,
			adminUserIds: [RIVAL.id],
		},
	});

	// -------------------------------------------------------------------------
	// 2. Food data files (household-scoped paths, matching
	//    resolveScopedDataDir's real households/<hh>/... layout)
	// -------------------------------------------------------------------------

	const pantryContent = `${generateFrontmatter({
		title: 'Pantry',
		type: 'pantry',
		tags: ['pas/food/pantry'],
	})}# Pantry\n\n## Active\n- milk (1 gallon, exp 2026-07-10)\n- eggs (dozen)\n- flour (5 lb bag)\n\n## Archive\n`;

	const groceryContent = `${generateFrontmatter({
		title: 'Grocery List',
		type: 'grocery-list',
		tags: ['pas/food/grocery'],
	})}# Grocery List\n\n## Active\n- bread\n- butter\n- coffee\n\n## Archive\n`;

	// Household-shared pantry/grocery — visible to all home-main members.
	const sharedFoodDir = join(dataDir, 'households', HH_MAIN, 'shared', 'food');
	await mkdir(sharedFoodDir, { recursive: true });
	await writeFile(join(sharedFoodDir, 'pantry.md'), pantryContent, 'utf-8');
	await writeFile(join(sharedFoodDir, 'grocery-list.md'), groceryContent, 'utf-8');

	// Files matching the food manifest's DECLARED data scopes (grocery/,
	// recipes/ — see apps/food/manifest.yaml requirements.data.shared_scopes).
	// FileIndexService only indexes files inside declared scopes, so these are
	// what the alert wizard's data-source picker actually lists. pantry.md /
	// grocery-list.md above are intentionally out-of-scope (they exercise the
	// picker's exclusion behavior + serve the alert read-path via user copies).
	await mkdir(join(sharedFoodDir, 'grocery'), { recursive: true });
	await writeFile(join(sharedFoodDir, 'grocery', 'grocery-list.md'), groceryContent, 'utf-8');
	await mkdir(join(sharedFoodDir, 'recipes'), { recursive: true });
	await writeFile(
		join(sharedFoodDir, 'recipes', 'dinner-ideas.md'),
		`${generateFrontmatter({ title: 'Dinner ideas', type: 'recipe', tags: ['pas/food/recipes'] })}\n## Active\n- Lasagna night special\n- Taco Tuesday\n`,
		'utf-8',
	);

	// Per-user food scratch files so FileIndexService has per-user entries too.
	// Matthew's copies of pantry.md/grocery-list.md double as the alert
	// data_sources below — AlertDefinition's data_source validator requires
	// user_id when space_id is absent (household-shared-only sources without
	// either field fail validation even though resolveScopedDataDir supports
	// them at read time; see gui-verify-harness report for details).
	for (const u of [MATTHEW, SAM]) {
		const userFoodDir = join(dataDir, 'households', HH_MAIN, 'users', u.id, 'food');
		await mkdir(userFoodDir, { recursive: true });
		await writeFile(
			join(userFoodDir, 'notes.md'),
			`${generateFrontmatter({ title: `${u.name}'s food notes`, type: 'note' })}# ${u.name}'s food notes\n\nNothing yet.\n`,
			'utf-8',
		);
	}
	await writeFile(
		join(dataDir, 'households', HH_MAIN, 'users', MATTHEW.id, 'food', 'pantry.md'),
		pantryContent,
		'utf-8',
	);
	await writeFile(
		join(dataDir, 'households', HH_MAIN, 'users', MATTHEW.id, 'food', 'grocery-list.md'),
		groceryContent,
		'utf-8',
	);

	// home-other pantry (isolation check — must not appear for home-main members)
	const otherSharedFoodDir = join(dataDir, 'households', HH_OTHER, 'shared', 'food');
	await mkdir(otherSharedFoodDir, { recursive: true });
	await writeFile(
		join(otherSharedFoodDir, 'pantry.md'),
		`${generateFrontmatter({ title: 'Pantry', type: 'pantry' })}# Pantry\n\n## Active\n- rice\n\n## Archive\n`,
		'utf-8',
	);

	// -------------------------------------------------------------------------
	// 3. llm-usage.md
	// -------------------------------------------------------------------------

	const usage = buildUsageLog();
	await writeFile(join(dataDir, 'system', 'llm-usage.md'), usage.content, 'utf-8');

	// -------------------------------------------------------------------------
	// 4. change-log.jsonl
	// -------------------------------------------------------------------------

	const changeLogSeed = buildChangeLog();
	await writeFile(join(dataDir, 'system', 'change-log.jsonl'), changeLogSeed.content, 'utf-8');

	// -------------------------------------------------------------------------
	// 5. Backups — fake .tar.gz files with different mtimes
	// -------------------------------------------------------------------------

	await writeFile(join(backupsDir, 'pas-backup-2026-07-01.tar.gz'), 'fake-backup-old', 'utf-8');
	await writeFile(join(backupsDir, 'pas-backup-2026-07-05.tar.gz'), 'fake-backup-new', 'utf-8');
	// Nudge mtimes apart so "different mtimes" is unambiguous even on fast filesystems.
	const oldTime = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
	const newTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	await import('node:fs/promises').then(({ utimes }) =>
		Promise.all([
			utimes(join(backupsDir, 'pas-backup-2026-07-01.tar.gz'), oldTime, oldTime),
			utimes(join(backupsDir, 'pas-backup-2026-07-05.tar.gz'), newTime, newTime),
		]),
	);

	// -------------------------------------------------------------------------
	// 6. Chat transcript index (real SQLite, compose-runtime's exact path)
	// -------------------------------------------------------------------------

	const chatDbPath = join(dataDir, 'system', 'chat-state.db');
	const transcriptSeed = createChatTranscriptIndex(chatDbPath);

	interface SessionSpec {
		id: string;
		userId: string;
		householdId: string;
		title: string;
		daysAgo: number;
		text: string;
	}

	const sessionSpecs: SessionSpec[] = [
		{
			id: 'sess-matthew-1',
			userId: MATTHEW.id,
			householdId: HH_MAIN,
			title: 'Dinner planning',
			daysAgo: 1,
			text: 'What should we make for dinner tonight?',
		},
		{
			id: 'sess-matthew-2',
			userId: MATTHEW.id,
			householdId: HH_MAIN,
			title: 'Grocery talk',
			daysAgo: 3,
			text: 'Add milk and eggs to the grocery list please.',
		},
		{
			id: 'sess-matthew-3',
			userId: MATTHEW.id,
			householdId: HH_MAIN,
			title: 'Lasagna night',
			daysAgo: 6,
			text: 'Can you find my lasagna recipe from last month?',
		},
		{
			id: 'sess-sam-1',
			userId: SAM.id,
			householdId: HH_MAIN,
			title: 'Pantry check',
			daysAgo: 2,
			text: 'Whats in the pantry right now?',
		},
		{
			id: 'sess-sam-2',
			userId: SAM.id,
			householdId: HH_MAIN,
			title: 'Leftovers',
			daysAgo: 5,
			text: 'Log the leftover chicken from last night.',
		},
		{
			id: 'sess-rival-1',
			userId: RIVAL.id,
			householdId: HH_OTHER,
			title: 'Rival session',
			daysAgo: 1,
			text: 'What is in my pantry?',
		},
	];

	const messagesThisWeekByUser = new Map<string, number>();
	const weekCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

	for (const s of sessionSpecs) {
		const startedAt = isoDaysAgo(s.daysAgo, 12);
		await transcriptSeed.upsertSession({
			id: s.id,
			user_id: s.userId,
			household_id: s.householdId,
			source: 'telegram',
			started_at: startedAt,
			ended_at: null,
			model: 'stub-model',
			title: s.title,
			parent_session_id: null,
		});
		// 2 messages per session: user + assistant, both at the session's timestamp.
		await transcriptSeed.appendMessage({
			session_id: s.id,
			turn_index: 0,
			role: 'user',
			content: s.text,
			timestamp: startedAt,
		});
		await transcriptSeed.appendMessage({
			session_id: s.id,
			turn_index: 1,
			role: 'assistant',
			content: `Sure — here's what I found regarding: ${s.text}`,
			timestamp: startedAt,
		});

		if (new Date(startedAt).getTime() >= weekCutoff) {
			messagesThisWeekByUser.set(s.userId, (messagesThisWeekByUser.get(s.userId) ?? 0) + 2);
		}
	}
	await transcriptSeed.close();

	// -------------------------------------------------------------------------
	// 7. Compose the real runtime (no network, no listen yet)
	// -------------------------------------------------------------------------

	const logger = pino({ level: 'silent' });
	const tempCostTracker = new CostTracker(dataDir, logger);

	const runtime = await composeRuntime({
		dataDir,
		configPath,
		config,
		providerRegistry: createStubProviderRegistry(tempCostTracker, logger, {
			p50Ms: 1,
			p95Ms: 2,
			capMs: 5,
		}),
		telegramService: fakeTelegramService(),
		logger,
	});

	const { services } = runtime;

	// -------------------------------------------------------------------------
	// 8. Credentials — GUI login passwords for all three users
	// -------------------------------------------------------------------------

	const credentialService = (services as unknown as { credentialService?: unknown })
		.credentialService as
		| { setPassword(userId: string, plaintext: string): Promise<void> }
		| undefined;

	// credentialService isn't on RuntimeServices' typed surface but composeRuntime
	// wires one internally and passes it to registerGuiRoutes; re-derive one here
	// against the same dataDir so setPassword() writes to the same credentials.yaml.
	const { CredentialService } = await import('../core/src/services/credentials/index.js');
	const credSvc = new CredentialService({ dataDir, logger });
	await credSvc.setPassword(MATTHEW.id, MATTHEW.password);
	await credSvc.setPassword(SAM.id, SAM.password);
	await credSvc.setPassword(RIVAL.id, RIVAL.password);
	void credentialService;

	// -------------------------------------------------------------------------
	// 9. Space: meal-planning (Matthew + Sam)
	// -------------------------------------------------------------------------

	await requestContext.run({ userId: MATTHEW.id, householdId: HH_MAIN }, async () => {
		await services.spaceService.saveSpace({
			id: 'meal-planning',
			name: 'Meal Planning',
			description: 'Shared meal planning space',
			members: [MATTHEW.id, SAM.id],
			createdBy: MATTHEW.id,
			createdAt: new Date().toISOString(),
			kind: 'household',
			householdId: HH_MAIN,
		});
	});

	// -------------------------------------------------------------------------
	// 10. Reports: 2 definitions + history files
	// -------------------------------------------------------------------------

	const reportMatthewOnly: ReportDefinition = {
		id: 'weekly-pantry-report',
		name: 'Weekly Pantry Report',
		description: 'Pantry status, delivered to Matthew only',
		enabled: true,
		schedule: '0 8 * * 1',
		delivery: [MATTHEW.id],
		// app-data section resolves via resolveScopedDataDir; user_id is supplied
		// explicitly (rather than space_id) to keep resolution deterministic.
		sections: [
			{
				type: 'app-data',
				label: 'Pantry',
				config: { app_id: 'food', user_id: MATTHEW.id, path: 'notes.md' },
			},
		],
		llm: { enabled: false },
	};

	const reportBoth: ReportDefinition = {
		id: 'household-changes-report',
		name: 'Household Changes Report',
		description: 'Recent changes, delivered to both Matthew and Sam',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: [MATTHEW.id, SAM.id],
		sections: [
			{
				type: 'changes',
				label: 'Recent Changes',
				config: { lookback_hours: 168, app_filter: [] },
			},
		],
		llm: { enabled: false },
	};

	await requestContext.run({ userId: MATTHEW.id, householdId: HH_MAIN }, async () => {
		const errs1 = await services.reportService.saveReport(reportMatthewOnly);
		const errs2 = await services.reportService.saveReport(reportBoth);
		if (errs1.length) console.error('[gui-verify-harness] reportMatthewOnly errors:', errs1);
		if (errs2.length) console.error('[gui-verify-harness] reportBoth errors:', errs2);
	});

	// Hand-write report-history files (matching ReportService.saveToHistory's
	// exact filename convention: data/system/report-history/{id}/{date}_{time}.md)
	async function writeReportHistory(
		reportId: string,
		daysAgo: number,
		name: string,
	): Promise<void> {
		const dir = join(dataDir, 'system', 'report-history', reportId);
		await mkdir(dir, { recursive: true });
		const now = isoDaysAgo(daysAgo, 8);
		const dateStr = now.slice(0, 10);
		const timeStr = now.slice(11, 23).replace(/[:.]/g, '-');
		const fm = generateFrontmatter({
			title: name,
			date: dateStr,
			created: now,
			tags: ['pas/report', `pas/report/${reportId}`],
			type: 'report',
			source: 'pas-reports',
		});
		await writeFile(
			join(dir, `${dateStr}_${timeStr}.md`),
			`${fm}# ${name}\n\nSeeded history entry.\n`,
			'utf-8',
		);
	}
	await writeReportHistory('weekly-pantry-report', 7, 'Weekly Pantry Report');
	await writeReportHistory('household-changes-report', 7, 'Household Changes Report');
	await writeReportHistory('household-changes-report', 0, 'Household Changes Report');

	// -------------------------------------------------------------------------
	// 11. Alerts: 2 definitions + backdated alert-history entries
	// -------------------------------------------------------------------------

	const alertMilkPantry: AlertDefinition = {
		id: 'pantry-milk-alert',
		name: 'Pantry Has Milk',
		description: 'Fires when the shared pantry contains milk',
		enabled: true,
		schedule: '0 * * * *',
		condition: {
			type: 'deterministic',
			expression: 'contains "milk"',
			// AlertDefinition's data_source validator requires user_id when space_id
			// is absent, so this points at Matthew's per-user pantry.md copy (seeded
			// identically to the household-shared copy) rather than the shared file.
			data_sources: [{ app_id: 'food', user_id: MATTHEW.id, path: 'pantry.md' }],
		},
		actions: [
			{
				type: 'telegram_message',
				config: { message: 'Pantry has milk: {data}' },
			},
		],
		delivery: [SAM.id],
		cooldown: '1 hour',
	};

	const alertMatthewOnly: AlertDefinition = {
		id: 'grocery-list-alert',
		name: 'Grocery List Not Empty',
		description: 'Fires when the shared grocery list is non-empty, delivered to Matthew only',
		enabled: true,
		schedule: '0 8 * * *',
		condition: {
			type: 'deterministic',
			expression: 'not empty',
			data_sources: [{ app_id: 'food', user_id: MATTHEW.id, path: 'grocery-list.md' }],
		},
		actions: [
			{
				type: 'telegram_message',
				config: { message: 'Grocery list needs attention: {data}' },
			},
		],
		delivery: [MATTHEW.id],
		cooldown: '1 hour',
	};

	await requestContext.run({ userId: MATTHEW.id, householdId: HH_MAIN }, async () => {
		const errs1 = await services.alertService.saveAlert(alertMilkPantry);
		const errs2 = await services.alertService.saveAlert(alertMatthewOnly);
		if (errs1.length) console.error('[gui-verify-harness] alertMilkPantry errors:', errs1);
		if (errs2.length) console.error('[gui-verify-harness] alertMatthewOnly errors:', errs2);
	});

	// Hand-write alert-history files matching AlertService.saveToHistory's exact
	// convention: data/system/alert-history/{alertId}/{YYYY-MM-DD}_{HH-mm-ss-SSS}.md
	const alertFiringsByDay = new Map<string, number>();
	async function writeAlertHistory(
		alertId: string,
		daysAgo: number,
		hour: number,
		conditionMet: boolean,
	): Promise<void> {
		const dir = join(dataDir, 'system', 'alert-history', alertId);
		await mkdir(dir, { recursive: true });
		const now = isoDaysAgo(daysAgo, hour);
		const dateStr = now.slice(0, 10);
		const timeStr = now.slice(11, 23).replace(/[:.]/g, '-');
		const fm = generateFrontmatter({
			title: `Alert: ${alertId}`,
			date: dateStr,
			created: now,
			tags: ['pas/alert', `pas/alert/${alertId}`],
			type: 'alert',
			source: 'pas-alerts',
		});
		const content = [
			`# Alert: ${alertId}`,
			`**Fired at:** ${now}`,
			`**Condition met:** ${conditionMet}`,
			`**Actions triggered:** ${conditionMet}`,
			`**Actions executed:** ${conditionMet ? 1 : 0}`,
		].join('\n');
		await writeFile(join(dir, `${dateStr}_${timeStr}.md`), fm + content, 'utf-8');
		alertFiringsByDay.set(dateStr, (alertFiringsByDay.get(dateStr) ?? 0) + 1);
	}

	await writeAlertHistory('pantry-milk-alert', 1, 9, true);
	await writeAlertHistory('pantry-milk-alert', 2, 9, true);
	await writeAlertHistory('pantry-milk-alert', 4, 9, true);
	await writeAlertHistory('grocery-list-alert', 1, 8, true);
	await writeAlertHistory('grocery-list-alert', 3, 8, true);

	// -------------------------------------------------------------------------
	// 12. Start listening (real Fastify listen — the ONLY network-facing step)
	// -------------------------------------------------------------------------

	await runtime.server.listen({ port: PORT, host: HOST });

	// -------------------------------------------------------------------------
	// 13. Write expected numbers for cross-checking
	// -------------------------------------------------------------------------

	const expected = {
		url: `http://${HOST}:${PORT}/gui/login`,
		seededDataDir: tempDir,
		credentials: {
			[MATTHEW.name]: {
				userId: MATTHEW.id,
				password: MATTHEW.password,
				isAdmin: true,
				household: HH_MAIN,
			},
			[SAM.name]: { userId: SAM.id, password: SAM.password, isAdmin: false, household: HH_MAIN },
			[RIVAL.name]: {
				userId: RIVAL.id,
				password: RIVAL.password,
				isAdmin: false,
				household: HH_OTHER,
			},
		},
		monthSpendUsd: {
			[MATTHEW.name]: usage.matthewMonthTotal,
			[SAM.name]: usage.samMonthTotal,
		},
		messagesThisWeek: {
			[MATTHEW.name]: messagesThisWeekByUser.get(MATTHEW.id) ?? 0,
			[SAM.name]: messagesThisWeekByUser.get(SAM.id) ?? 0,
			[RIVAL.name]: messagesThisWeekByUser.get(RIVAL.id) ?? 0,
		},
		alertFiringsByDay: Object.fromEntries(alertFiringsByDay),
		changeLogVisibility: {
			note: 'Members see: own entries, household-shared (userId=system, matching householdId), space entries for spaces they belong to. home-other entries must be invisible to home-main members.',
			matthewSeesDates: [dateDaysAgo(1), dateDaysAgo(2), dateDaysAgo(3), dateDaysAgo(5)],
			samSeesDates: [dateDaysAgo(2)],
			homeOtherEntryDate: dateDaysAgo(4),
			homeOtherVisibleToHomeMain: false,
		},
		spaces: { 'meal-planning': [MATTHEW.id, SAM.id] },
		alerts: {
			'pantry-milk-alert': {
				delivery: [SAM.id],
				conditionSource:
					"Matthew's pantry.md (data_source user_id, mirrors the shared copy) contains milk",
			},
			'grocery-list-alert': {
				delivery: [MATTHEW.id],
				conditionSource:
					"Matthew's grocery-list.md (data_source user_id, mirrors the shared copy) not empty",
			},
		},
		reports: {
			'weekly-pantry-report': { delivery: [MATTHEW.id] },
			'household-changes-report': { delivery: [MATTHEW.id, SAM.id] },
		},
		backups: {
			path: backupsDir,
			files: ['pas-backup-2026-07-01.tar.gz', 'pas-backup-2026-07-05.tar.gz'],
		},
	};

	const expectedPath = join(repoRoot, 'scripts', '.gui-verify-expected.json');
	await writeFile(expectedPath, `${JSON.stringify(expected, null, 2)}\n`, 'utf-8');

	// -------------------------------------------------------------------------
	// 14. Print everything
	// -------------------------------------------------------------------------

	console.log('='.repeat(78));
	console.log('PAS GUI verification harness — RUNNING');
	console.log('='.repeat(78));
	console.log(`URL:            http://${HOST}:${PORT}/gui/login`);
	console.log(`Seed data dir:  ${tempDir}`);
	console.log(`Expected JSON:  ${expectedPath}`);
	console.log('');
	console.log('Credentials:');
	console.log(
		`  ${MATTHEW.name} (admin)   id=${MATTHEW.id}  password=${MATTHEW.password}  household=${HH_MAIN}`,
	);
	console.log(
		`  ${SAM.name} (member)      id=${SAM.id}  password=${SAM.password}  household=${HH_MAIN}`,
	);
	console.log(
		`  ${RIVAL.name} (isolation) id=${RIVAL.id}  password=${RIVAL.password}  household=${HH_OTHER}`,
	);
	console.log('');
	console.log('Expected monthly LLM spend (current month, USD):');
	console.log(`  ${MATTHEW.name}: $${usage.matthewMonthTotal.toFixed(2)}`);
	console.log(`  ${SAM.name}: $${usage.samMonthTotal.toFixed(2)}`);
	console.log('');
	console.log('Expected messages-this-week (transcript index, last 7 days):');
	for (const [name, id] of [
		[MATTHEW.name, MATTHEW.id],
		[SAM.name, SAM.id],
		[RIVAL.name, RIVAL.id],
	] as const) {
		console.log(`  ${name}: ${messagesThisWeekByUser.get(id) ?? 0}`);
	}
	console.log('');
	console.log('Expected alert firings by day:');
	for (const [date, count] of [...alertFiringsByDay.entries()].sort()) {
		console.log(`  ${date}: ${count}`);
	}
	console.log('');
	console.log('Change-log visibility matrix:');
	console.log(
		`  Matthew should see entries on: ${expected.changeLogVisibility.matthewSeesDates.join(', ')}`,
	);
	console.log(
		`  Sam should see entries on:     ${expected.changeLogVisibility.samSeesDates.join(', ')}`,
	);
	console.log(
		`  home-other entry (${expected.changeLogVisibility.homeOtherEntryDate}) must NOT be visible to home-main members`,
	);
	console.log('');
	console.log('Press Ctrl+C to stop.');
	console.log('='.repeat(78));

	// -------------------------------------------------------------------------
	// 15. Graceful shutdown on SIGINT/SIGTERM
	// -------------------------------------------------------------------------

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log('\n[gui-verify-harness] shutting down...');
		await runtime.dispose();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	console.error('[gui-verify-harness] fatal error:', err);
	process.exit(1);
});
