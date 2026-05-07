/**
 * Production-wiring integration test for chat.recall.max_window_days.
 *
 * Verifies the full config-load → classifyRecallIntent path: a real loadSystemConfig
 * call with max_window_days: 30 in pas.yaml causes a 60-day-old window to be rejected
 * by classifyRecallIntent via RECALL_SAFE_DEFAULT.
 *
 * REQ-CONV-TEMPORAL-013, REQ-CONV-TEMPORAL-015.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSystemConfig } from '../../config/index.js';
import {
	RECALL_SAFE_DEFAULT,
	classifyRecallIntent,
} from '../../conversation-retrieval/recall-classifier.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'rp-int-'));
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(tempDir, { recursive: true, force: true });
});

const MINIMAL_USERS_YAML = `
users:
  - id: "u1"
    name: Test
    is_admin: true
    enabled_apps: ["*"]
    household_id: "h1"
households:
  - id: "h1"
    name: Test Household
    member_ids: ["u1"]
`;

async function writeMinimalConfig(
	dir: string,
	extraYaml: string,
): Promise<{ envPath: string; configPath: string }> {
	const envPath = join(dir, '.env');
	const configPath = join(dir, 'pas.yaml');
	await writeFile(
		envPath,
		'TELEGRAM_BOT_TOKEN=test-bot-token\nANTHROPIC_API_KEY=test-api-key\nGUI_AUTH_TOKEN=test-gui-token\n',
		'utf-8',
	);
	await writeFile(configPath, MINIMAL_USERS_YAML + extraYaml, 'utf-8');
	return { envPath, configPath };
}

describe('recall-pipeline integration — max_window_days config wiring', () => {
	it('honors chat.recall.max_window_days from real loadSystemConfig path', async () => {
		const dataDir = join(tempDir, 'data');
		await mkdir(dataDir, { recursive: true });

		const { envPath, configPath } = await writeMinimalConfig(
			tempDir,
			`chat:\n  recall:\n    max_window_days: 30\n`,
		);

		const cfg = await loadSystemConfig({ envPath, configPath });
		expect(cfg.chat?.recall?.max_window_days).toBe(30);

		// 2026-03-01 is 67 days before 2026-05-07 — exceeds cap of 30 → should be rejected
		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'budget planning',
			timeAnchor: { type: 'window', after: '2026-03-01', before: '2026-05-07' },
			reason: '60-day window',
		});

		const deps = {
			llm: { complete: vi.fn().mockResolvedValue(raw) },
			logger: { warn: vi.fn() },
			today: '2026-05-07',
			maxWindowDays: cfg.chat?.recall?.max_window_days ?? 365,
		};

		const verdict = await classifyRecallIntent('test message', deps);
		expect(verdict).toEqual(RECALL_SAFE_DEFAULT);
	});

	it('default 365 when chat.recall absent — 60-day window is accepted', async () => {
		const { envPath, configPath } = await writeMinimalConfig(tempDir, '');

		const cfg = await loadSystemConfig({ envPath, configPath });
		// Default materialization
		expect(cfg.chat?.recall?.max_window_days).toBe(365);

		const raw = JSON.stringify({
			shouldRecall: true,
			query: 'budget planning',
			timeAnchor: { type: 'window', after: '2026-03-01', before: '2026-05-07' },
			reason: '60-day window',
		});

		const deps = {
			llm: { complete: vi.fn().mockResolvedValue(raw) },
			logger: { warn: vi.fn() },
			today: '2026-05-07',
			maxWindowDays: cfg.chat?.recall?.max_window_days ?? 365,
		};

		const verdict = await classifyRecallIntent('test message', deps);
		expect(verdict.shouldRecall).toBe(true);
		expect(verdict.query).toBe('budget planning');
	});
});
