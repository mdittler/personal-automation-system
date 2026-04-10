import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	handleNutritionCommand,
	isNutritionViewIntent,
	handleAdherencePeriodCallback,
} from '../../handlers/nutrition.js';

// Mock targets-flow so beginTargetsFlow can be observed without actually
// starting the flow state machine.
vi.mock('../../handlers/targets-flow.js', () => ({
	beginTargetsFlow: vi.fn().mockResolvedValue(undefined),
	hasPendingTargetsFlow: vi.fn().mockReturnValue(false),
	handleTargetsFlowReply: vi.fn().mockResolvedValue(false),
	handleTargetsFlowCallback: vi.fn().mockResolvedValue(false),
	__resetTargetsFlowForTests: vi.fn(),
}));

import { beginTargetsFlow } from '../../handlers/targets-flow.js';

function createMockServices() {
	const userStore = {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
	};
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
		},
		llm: {
			complete: vi.fn().mockResolvedValue('Weekly nutrition summary.'),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		config: {
			get: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockResolvedValue({}),
			setAll: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
		},
		data: {
			forUser: vi.fn().mockReturnValue(userStore),
		},
		timezone: 'America/New_York',
	};
}

function createMockScopedStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('nutrition handler', () => {
	// ─── isNutritionViewIntent ─────────────────────────────────
	describe('isNutritionViewIntent', () => {
		it('detects nutrition-related queries', () => {
			expect(isNutritionViewIntent('how are my macros')).toBe(true);
			expect(isNutritionViewIntent("what's my calorie intake")).toBe(true);
			expect(isNutritionViewIntent('show nutrition summary')).toBe(true);
			expect(isNutritionViewIntent('protein intake this week')).toBe(true);
		});

		it('rejects unrelated queries', () => {
			expect(isNutritionViewIntent('add eggs to grocery list')).toBe(false);
			expect(isNutritionViewIntent("what's for dinner")).toBe(false);
		});
	});

	// ─── handleNutritionCommand ───────────────────────────────
	describe('handleNutritionCommand', () => {
		it('shows weekly summary with no args', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, [], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
		});

		it('handles "week" subcommand', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['week'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
		});

		it('handles "month" subcommand', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['month'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
		});

		it('shows macro targets', async () => {
			const services = createMockServices();
			// Mock user store to return saved targets
			const userStore = services.data.forUser('user1');
			userStore.read.mockResolvedValue('calories: 2000\nprotein: 150');
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('2000');
		});

		it('sets macro targets', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets', 'set', '2000', '150', '200', '70'], 'user1', store as never);
			const userStore = services.data.forUser('user1');
			expect(userStore.write).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledOnce();
		});

		it('handles "pediatrician" subcommand', async () => {
			const services = createMockServices();
			const store = createMockScopedStore({
				// loadAllChildren needs children files
				list: vi.fn().mockResolvedValue(['children/margot.yaml']),
				read: vi.fn().mockResolvedValue(`profile:\n  name: Margot\n  slug: margot\n  birthDate: "2024-06-15"\n  allergenStage: early-introduction\n  knownAllergens: []\n  avoidAllergens: []\n  dietaryNotes: ""\n  createdAt: "2026-01-01T00:00:00.000Z"\n  updatedAt: "2026-01-01T00:00:00.000Z"\nintroductions: []`),
			});
			await handleNutritionCommand(services as never, ['pediatrician', 'margot'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('Margot');
		});

		it('handles child not found', async () => {
			const services = createMockServices();
			const store = createMockScopedStore({
				list: vi.fn().mockResolvedValue([]),
			});
			await handleNutritionCommand(services as never, ['pediatrician', 'unknown'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/not found|no child/i);
		});

		it('shows child selection buttons when no child specified', async () => {
			const services = createMockServices();
			const store = createMockScopedStore({
				list: vi.fn().mockResolvedValue(['children/margot.yaml']),
				read: vi.fn().mockResolvedValue(`profile:\n  name: Margot\n  slug: margot\n  birthDate: "2024-06-15"\n  allergenStage: early-introduction\n  knownAllergens: []\n  avoidAllergens: []\n  dietaryNotes: ""\n  createdAt: "2026-01-01T00:00:00.000Z"\n  updatedAt: "2026-01-01T00:00:00.000Z"\nintroductions: []`),
			});
			await handleNutritionCommand(services as never, ['pediatrician'], 'user1', store as never);
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const buttons = services.telegram.sendWithButtons.mock.calls[0]![2] as Array<Array<{ text: string; callbackData: string }>>;
			expect(buttons[0]![0]!.text).toBe('Margot');
			expect(buttons[0]![0]!.callbackData).toBe('app:food:nut:ped:margot');
		});
	});

	// ─── Security ────────────────────────────────────────────
	describe('security', () => {
		it('rejects invalid macro target values', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets', 'set', 'abc', '150', '200', '70'], 'user1', store as never);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/invalid/i);
		});

		it('rejects negative macro target values', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets', 'set', '2000', '-10', '200', '70'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/invalid/i);
		});

		it('rejects excessively large macro target values', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets', 'set', '100000', '150', '200', '70'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/invalid/i);
		});
	});

	// ─── H11.x additions ──────────────────────────────────────
	describe('H11.x additions', () => {
		it('default subcommand shows today empty-state when no data', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, [], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/no macro data tracked for today/i);
		});

		it('logs a manual meal via /nutrition log', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(
				services as never,
				['log', 'lunch', '600', '40', '50', '20', '8'],
				'user1',
				store as never,
			);
			const userStore = services.data.forUser('user1');
			expect(userStore.write).toHaveBeenCalled();
			const writtenPath = userStore.write.mock.calls[0]![0] as string;
			expect(writtenPath).toMatch(/nutrition\/\d{4}-\d{2}\.yaml/);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('lunch');
			expect(msg).toContain('600');
		});

		it('rejects /nutrition log with missing label', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['log'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/usage/i);
		});

		it('rejects /nutrition log with invalid numeric args', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(
				services as never,
				['log', 'lunch', 'abc', '40', '50', '20'],
				'user1',
				store as never,
			);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/invalid/i);
			// Error message must identify the offending field (calories)
			// and echo the bad token so users can fix the right argument.
			expect(msg.toLowerCase()).toContain('calories');
			expect(msg).toContain('abc');
		});

		it('rejects /nutrition log with a label longer than 100 characters', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			const longLabel = 'a'.repeat(101);
			await handleNutritionCommand(
				services as never,
				['log', longLabel, '500', '30', '40', '15', '5'],
				'user1',
				store as never,
			);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/100 characters/i);
			// Nothing should have been written.
			const userStore = services.data.forUser('user1');
			expect(userStore.write).not.toHaveBeenCalled();
		});

		it('/nutrition targets set persists fiber', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(
				services as never,
				['targets', 'set', '2000', '150', '200', '70', '30'],
				'user1',
				store as never,
			);
			const userStore = services.data.forUser('user1');
			const written = userStore.write.mock.calls[0]![1] as string;
			expect(written).toContain('fiber: 30');
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('Fiber: 30');
		});

		it('/nutrition targets shows fiber row', async () => {
			const services = createMockServices();
			const userStore = services.data.forUser('user1');
			userStore.read.mockResolvedValue('calories: 2000\nprotein: 150\nfiber: 30');
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('Fiber: 30g');
		});

		it('loadTargets reads from user_config when set', async () => {
			const services = createMockServices();
			services.config.get.mockImplementation(async (key: string) => {
				if (key === 'macro_target_calories') return 2200;
				if (key === 'macro_target_protein') return 160;
				return 0;
			});
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('2200');
			expect(msg).toContain('160');
		});

		it('/nutrition adherence reports "no targets" when unset', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['adherence'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/no macro targets set/i);
		});

		it('/nutrition adherence reports no data when targets set but no logs', async () => {
			const services = createMockServices();
			const userStore = services.data.forUser('user1');
			userStore.read.mockResolvedValue('calories: 2000\nprotein: 150');
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['adherence', '7'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/no macro data tracked/i);
		});

		// ─── Regression guards ──────────────────────────────
		//
		// These pin two invariants that are easy to lose silently:
		//
		//  #22 — partial-config fallback: when the GUI sets a subset of
		//       macro_target_* keys (e.g. only calories), the unset keys
		//       must fall through to the YAML file, not get dropped to
		//       "not set". The bug: loadTargets short-circuits on the
		//       first non-zero config value and returns only that key.
		//
		//  #23 — saveTargets dual-write: /nutrition targets set must
		//       write BOTH the YAML file AND services.config.setAll with
		//       all 5 macro_target_* keys. If a future refactor drops
		//       the config mirror, the GUI and CLI silently desync.
		it('/nutrition targets merges partial config overrides over YAML fallback', async () => {
			const services = createMockServices();
			// GUI has set only calories — protein/carbs/fat/fiber remain at 0
			// (the default for unset number keys in the manifest).
			services.config.get.mockImplementation(async (key: string) => {
				if (key === 'macro_target_calories') return 2200;
				return 0;
			});
			// YAML file holds a historical full set the user created via CLI.
			const userStore = services.data.forUser('user1');
			userStore.read.mockResolvedValue('calories: 2000\nprotein: 150\nfiber: 30');
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets'], 'user1', store as never);
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			// Config override wins for calories.
			expect(msg).toContain('2200');
			// Unset config keys must fall through to the YAML values, not
			// be dropped to "not set".
			expect(msg).toContain('150');
			expect(msg).toContain('30');
		});

		it('/nutrition adherence reports daysHit, percentHit and a streak line', async () => {
			// Seed a 7-day history where 5 days are within ±10% of a
			// 2000 cal target. The handler must render "5 / 7", "71%",
			// and a "streak" line.
			const services = createMockServices();
			const tz = services.timezone;
			// Build last-7-days dates (today inclusive), matching what
			// the handler will compute via todayDate(timezone).
			const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
			const dates: string[] = [];
			for (let i = 6; i >= 0; i--) {
				const d = new Date(todayStr);
				d.setUTCDate(d.getUTCDate() - i);
				dates.push(d.toISOString().slice(0, 10));
			}
			// 5 hits (1900..2100), 2 misses (500, 3500).
			const dailyCalories = [1900, 2000, 2100, 500, 2000, 2000, 3500];
			const days = dates.map((date, i) => ({
				date,
				meals: [],
				totals: { calories: dailyCalories[i]!, protein: 0, carbs: 0, fat: 0, fiber: 0 },
			}));
			// Bucket days by month so the handler's loadMacrosForPeriod
			// iteration picks them up.
			const byMonth = new Map<string, typeof days>();
			for (const d of days) {
				const month = d.date.slice(0, 7);
				if (!byMonth.has(month)) byMonth.set(month, []);
				byMonth.get(month)!.push(d);
			}

			const userStore = services.data.forUser('user1');
			userStore.read.mockImplementation(async (path: string) => {
				if (path === 'nutrition/targets.yaml') return 'calories: 2000';
				const m = path.match(/^nutrition\/(\d{4}-\d{2})\.yaml$/);
				if (m) {
					const month = m[1]!;
					const monthDays = byMonth.get(month) ?? [];
					return `month: "${month}"\nuserId: user1\ndays:\n${monthDays
						.map(
							(d) =>
								`  - date: "${d.date}"\n    meals: []\n    totals:\n      calories: ${d.totals.calories}\n      protein: 0\n      carbs: 0\n      fat: 0\n      fiber: 0`,
						)
						.join('\n')}`;
				}
				return null;
			});
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['adherence', '7'], 'user1', store as never);

			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toContain('5 / 7');
			expect(msg).toContain('71%');
			expect(msg).toMatch(/streak/i);
		});

		it('/nutrition week feeds adherence context to the LLM when targets and data are set', async () => {
			// /nutrition week calls generatePersonalSummary which
			// renders an LLM prompt including an "Adherence:" section
			// when computeProgress produces an adherence block. The
			// user-visible output is the LLM response, so the invariant
			// under test is the *prompt* the LLM receives.
			const services = createMockServices();
			const tz = services.timezone;
			const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
			const dates: string[] = [];
			for (let i = 6; i >= 0; i--) {
				const d = new Date(todayStr);
				d.setUTCDate(d.getUTCDate() - i);
				dates.push(d.toISOString().slice(0, 10));
			}
			// All within ±10% of 2000 → full hit streak.
			const days = dates.map((date) => ({
				date,
				meals: [],
				totals: { calories: 2000, protein: 150, carbs: 0, fat: 0, fiber: 0 },
			}));
			const byMonth = new Map<string, typeof days>();
			for (const d of days) {
				const month = d.date.slice(0, 7);
				if (!byMonth.has(month)) byMonth.set(month, []);
				byMonth.get(month)!.push(d);
			}

			const userStore = services.data.forUser('user1');
			userStore.read.mockImplementation(async (path: string) => {
				if (path === 'nutrition/targets.yaml') return 'calories: 2000\nprotein: 150';
				const m = path.match(/^nutrition\/(\d{4}-\d{2})\.yaml$/);
				if (m) {
					const month = m[1]!;
					const monthDays = byMonth.get(month) ?? [];
					return `month: "${month}"\nuserId: user1\ndays:\n${monthDays
						.map(
							(d) =>
								`  - date: "${d.date}"\n    meals: []\n    totals:\n      calories: ${d.totals.calories}\n      protein: ${d.totals.protein}\n      carbs: 0\n      fat: 0\n      fiber: 0`,
						)
						.join('\n')}`;
				}
				return null;
			});
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['week'], 'user1', store as never);

			// Assert the prompt sent to the LLM included the adherence
			// block rendered from the seeded hits.
			expect(services.llm.complete).toHaveBeenCalled();
			const prompt = services.llm.complete.mock.calls[0]![0] as string;
			expect(prompt).toMatch(/Adherence/);
			expect(prompt).toMatch(/on target/);
		});

		it('/nutrition targets set mirrors all 5 macro_target_* keys to services.config.setAll', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(
				services as never,
				['targets', 'set', '2000', '150', '200', '70', '30'],
				'user1',
				store as never,
			);
			// YAML write (CLI source of truth).
			const userStore = services.data.forUser('user1');
			expect(userStore.write).toHaveBeenCalled();
			// Config mirror (GUI source of truth).
			expect(services.config.setAll).toHaveBeenCalledOnce();
			const [mirroredUserId, mirroredValues] = services.config.setAll.mock.calls[0]!;
			expect(mirroredUserId).toBe('user1');
			expect(mirroredValues).toMatchObject({
				macro_target_calories: 2000,
				macro_target_protein: 150,
				macro_target_carbs: 200,
				macro_target_fat: 70,
				macro_target_fiber: 30,
			});
		});
	});

	// ─── H11.y additions ──────────────────────────────────────────────────────
	describe('H11.y additions', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('/nutrition adherence no args → sends period picker buttons', async () => {
			const services = createMockServices();
			const userStore = services.data.forUser('user1');
			// Seed targets so the "no targets" guard passes.
			userStore.read.mockResolvedValue('calories: 2000');
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['adherence'], 'user1', store as never);
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const buttons = services.telegram.sendWithButtons.mock.calls[0]![2] as Array<Array<{ text: string; callbackData: string }>>;
			const flatButtons = buttons.flat();
			expect(flatButtons.some(b => b.callbackData === 'app:food:nut:adh:7')).toBe(true);
			expect(flatButtons.some(b => b.callbackData === 'app:food:nut:adh:30')).toBe(true);
			expect(flatButtons.some(b => b.callbackData === 'app:food:nut:adh:90')).toBe(true);
		});

		it('handleAdherencePeriodCallback with app:food:nut:adh:7 runs adherence and sends result', async () => {
			const services = createMockServices();
			const tz = services.timezone;
			const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
			const dates: string[] = [];
			for (let i = 6; i >= 0; i--) {
				const d = new Date(todayStr);
				d.setUTCDate(d.getUTCDate() - i);
				dates.push(d.toISOString().slice(0, 10));
			}
			const days = dates.map((date) => ({
				date,
				meals: [],
				totals: { calories: 2000, protein: 150, carbs: 0, fat: 0, fiber: 0 },
			}));
			const byMonth = new Map<string, typeof days>();
			for (const d of days) {
				const month = d.date.slice(0, 7);
				if (!byMonth.has(month)) byMonth.set(month, []);
				byMonth.get(month)!.push(d);
			}
			const userStore = createMockScopedStore({
				read: vi.fn().mockImplementation(async (path: string) => {
					if (path === 'nutrition/targets.yaml') return 'calories: 2000\nprotein: 150';
					const m = path.match(/^nutrition\/(\d{4}-\d{2})\.yaml$/);
					if (m) {
						const month = m[1]!;
						const monthDays = byMonth.get(month) ?? [];
						return `month: "${month}"\nuserId: user1\ndays:\n${monthDays
							.map(
								(d) =>
									`  - date: "${d.date}"\n    meals: []\n    totals:\n      calories: ${d.totals.calories}\n      protein: ${d.totals.protein}\n      carbs: 0\n      fat: 0\n      fiber: 0`,
							)
							.join('\n')}`;
					}
					return null;
				}),
			});
			await handleAdherencePeriodCallback(
				services as never,
				userStore as never,
				'user1',
				'app:food:nut:adh:7',
			);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			// Should show the adherence result, not the button picker.
			expect(msg).toContain('Adherence');
			expect(msg).toContain('7 days');
		});

		it('/nutrition targets set no args → calls beginTargetsFlow', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(services as never, ['targets', 'set'], 'user1', store as never);
			expect(beginTargetsFlow).toHaveBeenCalledOnce();
			// Should NOT have sent the "Invalid targets" error.
			expect(services.telegram.send).not.toHaveBeenCalled();
		});

		it('/nutrition targets set with numeric args still works as positional shortcut', async () => {
			const services = createMockServices();
			const store = createMockScopedStore();
			await handleNutritionCommand(
				services as never,
				['targets', 'set', '2000', '150', '200', '70'],
				'user1',
				store as never,
			);
			// beginTargetsFlow should NOT have been called
			expect(beginTargetsFlow).not.toHaveBeenCalled();
			// Should write and confirm
			const userStore = services.data.forUser('user1');
			expect(userStore.write).toHaveBeenCalled();
			expect(services.telegram.send).toHaveBeenCalledOnce();
		});
	});
});
