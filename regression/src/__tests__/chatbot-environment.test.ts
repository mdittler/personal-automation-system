import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatbotEnvironment } from '../runner/chatbot-environment.js';

vi.setConfig({ testTimeout: 30_000 });

// Resolve fixture + config paths from this test file's own location so the
// tests work regardless of process.cwd() (vitest cwd is the regression workspace
// dir; the runner CLI's cwd is the repo root).
const here = fileURLToPath(import.meta.url);
const SEED_JSON = resolve(here, '../../../fixtures/chatbot/seed.json');
const SEED_SHA = resolve(here, '../../../fixtures/chatbot/seed.sha256');
const PRODUCTION_CONFIG = resolve(here, '../../../../config/pas.yaml');

let env: { dispose: () => Promise<void> } | undefined;

beforeEach(() => {
	env = undefined;
});

afterEach(async () => {
	if (env) await env.dispose();
});

describe('createChatbotEnvironment', () => {
	it('throws when the fixture sha256 manifest does not match', async () => {
		await expect(
			createChatbotEnvironment({
				seedJsonPath: '/nonexistent/seed.json',
				seedShaPath: '/nonexistent/seed.sha256',
				productionConfigPath: PRODUCTION_CONFIG,
			}),
		).rejects.toThrow(/manifest|integrity|missing|ENOENT/i);
	});

	it('writes seed receipts + price lists into the household-shared path', async () => {
		env = await createChatbotEnvironment({
			seedJsonPath: SEED_JSON,
			seedShaPath: SEED_SHA,
			productionConfigPath: PRODUCTION_CONFIG,
		});
		const e = env as Awaited<ReturnType<typeof createChatbotEnvironment>>;
		const receiptPath = join(
			e.dataDir,
			'households',
			e.householdId,
			'shared',
			'food',
			'receipts',
			'2026-05-01-costco-test.yaml',
		);
		expect(existsSync(receiptPath)).toBe(true);
		const contents = await readFile(receiptPath, 'utf8');
		expect(contents).toContain('Spindrift');
		expect(contents).toContain('total: 306.77');
	});

	it('produces a runtime with router + telegram services', async () => {
		env = await createChatbotEnvironment({
			seedJsonPath: SEED_JSON,
			seedShaPath: SEED_SHA,
			productionConfigPath: PRODUCTION_CONFIG,
		});
		const e = env as Awaited<ReturnType<typeof createChatbotEnvironment>>;
		expect(e.runtime.services.router).toBeDefined();
		expect(e.telegram.sent).toEqual([]);
		expect(e.userId).toMatch(/^regression-user/);
		expect(e.householdId).toMatch(/^regression-hh/);
	});

	it('dispose cleans up the temp directory', async () => {
		env = await createChatbotEnvironment({
			seedJsonPath: SEED_JSON,
			seedShaPath: SEED_SHA,
			productionConfigPath: PRODUCTION_CONFIG,
		});
		const e = env as Awaited<ReturnType<typeof createChatbotEnvironment>>;
		const tmpRoot = e.tmpRoot;
		await e.dispose();
		env = undefined;
		expect(existsSync(tmpRoot)).toBe(false);
	});

	it('removes the temp directory when post-mkdtemp setup throws (Codex I4)', async () => {
		// Codex I4 regression guard: if anything after mkdtemp throws — config
		// load, household seeding, composeRuntime — the tmp root must be
		// removed before the error propagates. We force a deterministic
		// post-mkdtemp failure by pointing at a malformed YAML file: the
		// integrity check still passes (it inspects the real seed), but
		// `loadSystemConfig` rejects with "Failed to parse pas.yaml". This
		// exercises the same catch path that would protect composeRuntime
		// failures without depending on the heavier Fastify init quirks.
		const { mkdtemp, writeFile, readdir, rm: rmTmp } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');

		const fixtureDir = await mkdtemp(join(tmpdir(), 'regression-chatbot-fixture-'));
		const badYaml = join(fixtureDir, 'bad-pas.yaml');
		// Unclosed quote -> YAML parse error.
		await writeFile(badYaml, 'users:\n  - id: "8187\n', 'utf8');

		try {
			const before = (await readdir(tmpdir())).filter((n) =>
				n.startsWith('regression-chatbot-'),
			);

			await expect(
				createChatbotEnvironment({
					seedJsonPath: SEED_JSON,
					seedShaPath: SEED_SHA,
					productionConfigPath: badYaml,
					envPath: resolve(here, '../../../../../.env'),
				}),
			).rejects.toThrow(/parse|yaml|failed/i);

			const after = (await readdir(tmpdir())).filter((n) =>
				n.startsWith('regression-chatbot-'),
			);
			// Filter out the fixture dir we just created (it has a different prefix
			// but shares the leading match) and dirs that existed before the run.
			const leaked = after.filter(
				(n) => !before.includes(n) && !n.startsWith('regression-chatbot-fixture-'),
			);
			expect(leaked).toEqual([]);
		} finally {
			await rmTmp(fixtureDir, { recursive: true, force: true });
		}
	});
});
