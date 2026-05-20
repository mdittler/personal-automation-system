/**
 * End-to-end integration tests for the App-Message Memory Bridge.
 *
 * These tests exercise the bridge through the SAME wiring used in production:
 *   - composeRuntime() builds the real ReportService, AlertService, food app,
 *     ChatSessionStore, AppConfigService, and LateBoundAppOutboundBridge.
 *   - We trigger flows the way they fire in production (reportService.run,
 *     alertService.evaluate, food.handleScheduledJob) and assert that the
 *     bridge wrote a synthetic exchange into the user's chat transcript.
 *
 * Scenarios:
 *   I1     — weekly nutrition scheduled job appends `[App: food] weekly-nutrition`
 *   I2     — alert telegram_message action appends `[App: alerts] alert:<slug>:telegram`
 *            to every delivery recipient's transcript
 *   I3     — report delivery appends `[App: reports] report:<id>` to every delivery
 *            recipient's transcript
 *   I4     — opt-out user receives Telegram message but transcript stays clean
 *   I5     — bridge stamps the correct household_id on the session frontmatter
 *   I6     — Telegram failure for one recipient skips the bridge call for that user
 *
 * I-DISP (dispatch_message non-double-record) is deferred — wiring an alert that
 * routes a synthetic message through the Router into a real app handler is
 * disproportionately tangled for the marginal coverage. The invariant is already
 * enforced at the source (alert-executor only bridges telegram_message, never
 * dispatch_message), and the relevant unit test exists in
 * `core/src/services/alerts/__tests__/alert-executor.test.ts`.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { composeRuntime } from '../../../compose-runtime.js';
import { fakeTelegramService } from '../../../testing/fixtures/fake-telegram.js';
import { seedUsers } from '../../../testing/fixtures/seed-users.js';
import {
	StubProvider,
	createStubProviderRegistry,
} from '../../../testing/fixtures/stub-llm-provider.js';
import type { AlertDefinition } from '../../../types/alert.js';
import type { ReportDefinition } from '../../../types/report.js';
import { AppConfigServiceImpl } from '../../config/app-config-service.js';
import { requestContext } from '../../context/request-context.js';
import { buildSessionKey } from '../../conversation-session/session-key.js';
import { CostTracker } from '../../llm/cost-tracker.js';

const INT_TEST_TIMEOUT_MS = 30_000;
const STUB_OPTIONS = { p50Ms: 1, p95Ms: 2, capMs: 5 } as const;

function dmSessionKey(userId: string): string {
	return buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: userId });
}

describe.sequential(
	'AppOutboundBridge end-to-end integration',
	{ timeout: INT_TEST_TIMEOUT_MS },
	() => {
		let tempDir = '';
		let runtime: Awaited<ReturnType<typeof composeRuntime>>;
		let telegram: ReturnType<typeof fakeTelegramService>;
		// Two users in the SAME household so report/alert deliveries with
		// 2 recipients don't trip the cross-household refusal.
		// seedUsers uses (i % householdCount), so user-0 and user-2 both → hh-0.
		const USER_A = 'user-0';
		const USER_C = 'user-2';
		let householdAId: string;

		beforeAll(async () => {
			tempDir = await mkdtemp(join(tmpdir(), 'pas-bridge-int-'));
			const logger = pino({ level: 'silent' });
			const seed = await seedUsers({ dataDir: tempDir, users: 4, households: 2 });
			householdAId = seed.users.find((u) => u.id === USER_A)!.householdId;

			telegram = fakeTelegramService();

			const tempCostTracker = new CostTracker(join(tempDir, 'data'), logger);
			runtime = await composeRuntime({
				dataDir: join(tempDir, 'data'),
				configPath: seed.configPath,
				config: seed.config,
				providerRegistry: createStubProviderRegistry(tempCostTracker, logger, STUB_OPTIONS),
				telegramService: telegram,
				logger,
			});

			// Re-register stub on the runtime's real CostTracker (mirrors
			// compose-runtime.smoke.integration.test.ts pattern).
			const realCostTracker = runtime.services.costTracker as CostTracker;
			runtime.services.providerRegistry.register(
				new StubProvider(realCostTracker, logger, STUB_OPTIONS),
			);

			// Seed the food household at the per-household shared path so
			// handleWeeklyNutritionSummaryJob's membership check passes.
			// `services.data.forShared('shared')` resolves to
			// data/households/<hhId>/shared/food/ when invoked under requestContext.
			const householdDir = join(tempDir, 'data', 'households', householdAId, 'shared', 'food');
			await mkdir(householdDir, { recursive: true });
			const householdYaml =
				`---\ntitle: Solo\napp: food\n---\n` +
				stringifyYaml({
					id: 'solo',
					name: 'Solo Family',
					createdBy: USER_A,
					members: [USER_A, USER_C],
					joinCode: 'ABC123',
					createdAt: '2026-01-01T00:00:00.000Z',
				});
			await writeFile(join(householdDir, 'household.yaml'), householdYaml, 'utf-8');

			// Seed a per-user food data file so I2's alert condition can fire on a
			// non-empty payload. alertService.readDataSources resolves
			// (user_id, path) → data/households/<hh>/users/<uid>/food/<path>.
			const userAFoodDir = join(
				tempDir,
				'data',
				'households',
				householdAId,
				'users',
				USER_A,
				'food',
			);
			await mkdir(userAFoodDir, { recursive: true });
			await writeFile(join(userAFoodDir, 'alert-trigger.md'), 'trigger line one\n', 'utf-8');
		}, INT_TEST_TIMEOUT_MS);

		afterAll(async () => {
			if (runtime) {
				await (runtime.services.costTracker as CostTracker).drainWrites();
				await runtime.dispose();
			}
			if (tempDir) {
				await rm(tempDir, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 100,
				});
			}
		}, INT_TEST_TIMEOUT_MS);

		// ─── I1 ──────────────────────────────────────────────────────────────────
		it('I1: weekly-nutrition-summary scheduled job appends [App: food] weekly-nutrition', async () => {
			const userId = USER_A;
			const sessionKey = dmSessionKey(userId);

			// Snapshot transcript length so we can isolate this test's appends.
			let beforeCount = 0;
			await requestContext.run({ userId, householdId: householdAId }, async () => {
				const turns = await runtime.services.chatSessions.loadRecentTurns({ userId, sessionKey });
				beforeCount = turns.length;
			});

			// Invoke the food app's handleScheduledJob the same way the cron path does —
			// inside requestContext.run, so services.data.forShared('shared') routes
			// to the seeded per-household path.
			const foodApp = runtime.services.registry.getApp('food');
			expect(foodApp?.module.handleScheduledJob).toBeDefined();

			await requestContext.run({ userId, householdId: householdAId }, async () => {
				await foodApp!.module.handleScheduledJob!('weekly-nutrition-summary', userId);
			});

			await requestContext.run({ userId, householdId: householdAId }, async () => {
				const turns = await runtime.services.chatSessions.loadRecentTurns({ userId, sessionKey });
				// Two new turns: user + assistant from the bridge.
				expect(turns.length).toBeGreaterThanOrEqual(beforeCount + 2);
				expect(turns.some((t) => t.content === '[App: food] weekly-nutrition')).toBe(true);
				// Body the user actually saw (empty macro data → fixed copy from
				// generatePersonalSummary). Substring check proves the bridge body matched.
				expect(
					turns.some((t) => t.role === 'assistant' && t.content.includes('No macro data recorded')),
				).toBe(true);
				// Provenance: app-bridged turns must be tagged source:'app'.
				const bridgeUserTurn = turns.find((t) => t.content === '[App: food] weekly-nutrition');
				expect(bridgeUserTurn?.source).toBe('app');
			});
		});

		// ─── I2 ──────────────────────────────────────────────────────────────────
		it('I2: alert telegram_message action appends to BOTH delivery recipient transcripts', async () => {
			const alert: AlertDefinition = {
				id: 'int-alert-tel',
				name: 'Int Alert Tel',
				enabled: true,
				schedule: '*/5 * * * *',
				condition: {
					type: 'deterministic',
					expression: 'not empty',
					data_sources: [
						// Reads data/households/<hh>/users/USER_A/food/alert-trigger.md
						// (seeded in beforeAll). Non-empty content → condition fires.
						{ app_id: 'food', user_id: USER_A, path: 'alert-trigger.md' },
					],
				},
				actions: [
					{
						type: 'telegram_message',
						config: { message: 'Heads up: {alert_name} fired.' },
					},
				],
				delivery: [USER_A, USER_C],
				cooldown: '1 minute',
			};
			const errors = await runtime.services.alertService.saveAlert(alert);
			expect(errors).toEqual([]);

			const sentBefore = telegram.sent.length;
			const result = await runtime.services.alertService.evaluate(alert.id);
			expect(result.conditionMet).toBe(true);
			expect(result.actionTriggered).toBe(true);

			// Telegram saw both recipients.
			const sentAfter = telegram.sent.slice(sentBefore);
			expect(sentAfter.filter((m) => m.userId === USER_A)).toHaveLength(1);
			expect(sentAfter.filter((m) => m.userId === USER_C)).toHaveLength(1);

			// Both transcripts contain the bridged header.
			const expectedHeader = '[App: alerts] alert:int-alert-tel:telegram';
			for (const uid of [USER_A, USER_C]) {
				await requestContext.run({ userId: uid, householdId: householdAId }, async () => {
					const turns = await runtime.services.chatSessions.loadRecentTurns({
						userId: uid,
						sessionKey: dmSessionKey(uid),
					});
					expect(turns.some((t) => t.content === expectedHeader)).toBe(true);
				});
			}
		});

		// ─── I3 ──────────────────────────────────────────────────────────────────
		it('I3: report delivery to two users appears in BOTH transcripts', async () => {
			const report: ReportDefinition = {
				id: 'int-report-spend',
				name: 'Int Report',
				enabled: true,
				schedule: '0 9 * * *',
				delivery: [USER_A, USER_C],
				sections: [
					{
						type: 'custom',
						label: 'Notice',
						config: { text: 'Hello from a report.' },
					},
				],
				llm: { enabled: false },
			};
			const errors = await runtime.services.reportService.saveReport(report);
			expect(errors).toEqual([]);

			const sentBefore = telegram.sent.length;
			const result = await runtime.services.reportService.run(report.id);
			expect(result).not.toBeNull();

			// Telegram saw both recipients.
			const sentAfter = telegram.sent.slice(sentBefore);
			expect(sentAfter.filter((m) => m.userId === USER_A)).toHaveLength(1);
			expect(sentAfter.filter((m) => m.userId === USER_C)).toHaveLength(1);

			// Both transcripts contain the bridged header.
			const expectedHeader = '[App: reports] report:int-report-spend';
			for (const uid of [USER_A, USER_C]) {
				await requestContext.run({ userId: uid, householdId: householdAId }, async () => {
					const turns = await runtime.services.chatSessions.loadRecentTurns({
						userId: uid,
						sessionKey: dmSessionKey(uid),
					});
					expect(turns.some((t) => t.content === expectedHeader)).toBe(true);
				});
			}
		});

		// ─── I4 ──────────────────────────────────────────────────────────────────
		it('I4: opt-out user — telegram still delivers, transcript untouched', async () => {
			const userId = USER_A;
			const sessionKey = dmSessionKey(userId);

			// Write opt-out via a fresh AppConfigServiceImpl pointed at the same path
			// the real conversationAppConfig uses
			// (data/system/app-config/chatbot/<userId>.yaml).
			const optOutWriter = new AppConfigServiceImpl({
				dataDir: join(tempDir, 'data'),
				appId: 'chatbot',
				defaults: [
					{
						key: 'app_message_bridge_enabled',
						type: 'boolean',
						default: true,
						description: 'Bridge enabled',
						label: 'Bridge enabled',
						category: 'personal',
					},
				],
			});
			await optOutWriter.setAll(userId, { app_message_bridge_enabled: false });

			let beforeBridged = 0;
			await requestContext.run({ userId, householdId: householdAId }, async () => {
				const turns = await runtime.services.chatSessions.loadRecentTurns({ userId, sessionKey });
				beforeBridged = turns.filter((t) => t.content.startsWith('[App:')).length;
			});

			// Mimic the production caller path (food handler): telegram send first,
			// then bridge. The bridge must skip the append because of the opt-out.
			const sentBefore = telegram.sent.length;
			await requestContext.run({ userId, householdId: householdAId }, async () => {
				await runtime.services.telegram.send(userId, 'opt-out body');
				await runtime.services.appOutboundBridge.recordOutboundMessage({
					userId,
					appId: 'food',
					kind: 'opt-out-check',
					body: 'opt-out body',
				});
			});

			// Telegram delivered.
			expect(telegram.sent.slice(sentBefore).some((m) => m.userId === userId)).toBe(true);

			// Transcript: no NEW [App: ...] entries for this user.
			await requestContext.run({ userId, householdId: householdAId }, async () => {
				const turns = await runtime.services.chatSessions.loadRecentTurns({ userId, sessionKey });
				const afterBridged = turns.filter((t) => t.content.startsWith('[App:')).length;
				expect(afterBridged).toBe(beforeBridged);
				expect(turns.some((t) => t.content === '[App: food] opt-out-check')).toBe(false);
			});

			// Re-enable so subsequent tests aren't affected.
			await optOutWriter.setAll(userId, { app_message_bridge_enabled: true });
		});

		// ─── I5 ──────────────────────────────────────────────────────────────────
		it('I5: bridge stamps the correct household_id on session frontmatter', async () => {
			// Reach for USER_C, which earlier tests have already minted a session for —
			// we just need to find that session file and verify its household_id.
			const userId = USER_C;
			const sessionKey = dmSessionKey(userId);

			// Make sure the session exists (idempotent if it does).
			await requestContext.run({ userId, householdId: householdAId }, async () => {
				await runtime.services.appOutboundBridge.recordOutboundMessage({
					userId,
					appId: 'food',
					kind: 'i5-frontmatter',
					body: 'i5 body',
				});
			});

			// Locate the active session via active-sessions.yaml — same pattern as
			// memory-snapshot-freeze.integration.test.ts.
			const sessionsDir = join(
				tempDir,
				'data',
				'households',
				householdAId,
				'users',
				userId,
				'chatbot',
				'conversation',
				'sessions',
			);
			const indexPath = join(sessionsDir, '..', 'active-sessions.yaml');
			const indexRaw = await readFile(indexPath, 'utf-8');
			const indexMap = parseYaml(indexRaw) as Record<string, { id: string } | undefined>;
			const sessionEntry = indexMap[sessionKey];
			expect(sessionEntry?.id).toBeDefined();

			const transcript = await readFile(join(sessionsDir, `${sessionEntry!.id}.md`), 'utf-8');
			const fmMatch = transcript.match(/^---\n([\s\S]*?)\n---\n/);
			expect(fmMatch).not.toBeNull();
			const frontmatter = parseYaml(fmMatch![1]!) as Record<string, unknown>;
			expect(frontmatter.household_id).toBe(householdAId);
			expect(frontmatter.user_id).toBe(userId);
		});

		// ─── I6 ──────────────────────────────────────────────────────────────────
		it('I6: telegram failure for one recipient skips the bridge call for that user only', async () => {
			// Patch the telegram fake to throw for USER_C only.
			const realSend = telegram.send.bind(telegram);
			const failUserId = USER_C;
			telegram.send = (async (uid: string, message: string) => {
				if (uid === failUserId) {
					throw new Error('simulated telegram failure');
				}
				return realSend(uid, message);
			}) as typeof telegram.send;

			const report: ReportDefinition = {
				id: 'int-report-failure',
				name: 'Int Report Failure',
				enabled: true,
				schedule: '0 9 * * *',
				delivery: [USER_A, USER_C],
				sections: [
					{
						type: 'custom',
						label: 'Notice',
						config: { text: 'Report with one bad recipient.' },
					},
				],
				llm: { enabled: false },
			};
			try {
				const errors = await runtime.services.reportService.saveReport(report);
				expect(errors).toEqual([]);

				// Snapshot USER_C transcript count before — we'll assert NO new entries
				// after run() (rather than absence of a specific header) so this test
				// isn't sensitive to USER_C's earlier transcripts from I2/I3.
				let userCBeforeBridged = 0;
				await requestContext.run({ userId: USER_C, householdId: householdAId }, async () => {
					const turns = await runtime.services.chatSessions.loadRecentTurns({
						userId: USER_C,
						sessionKey: dmSessionKey(USER_C),
					});
					userCBeforeBridged = turns.filter((t) => t.content.startsWith('[App: reports]')).length;
				});

				await runtime.services.reportService.run(report.id);

				const expectedHeader = '[App: reports] report:int-report-failure';
				// USER_A: telegram succeeded → transcript got the header.
				await requestContext.run({ userId: USER_A, householdId: householdAId }, async () => {
					const turns = await runtime.services.chatSessions.loadRecentTurns({
						userId: USER_A,
						sessionKey: dmSessionKey(USER_A),
					});
					expect(turns.some((t) => t.content === expectedHeader)).toBe(true);
				});
				// USER_C: telegram threw → bridge MUST NOT have written for this failure.
				await requestContext.run({ userId: USER_C, householdId: householdAId }, async () => {
					const turns = await runtime.services.chatSessions.loadRecentTurns({
						userId: USER_C,
						sessionKey: dmSessionKey(USER_C),
					});
					expect(turns.some((t) => t.content === expectedHeader)).toBe(false);
					// Count of report-bridged turns for USER_C is unchanged.
					const userCAfterBridged = turns.filter((t) =>
						t.content.startsWith('[App: reports]'),
					).length;
					expect(userCAfterBridged).toBe(userCBeforeBridged);
				});
			} finally {
				telegram.send = realSend;
			}
		});
	},
);
