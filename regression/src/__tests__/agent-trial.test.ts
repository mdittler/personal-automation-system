import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentExpectation, AgentTaskPayload } from '../cases/agent/types.js';
import { type AgentEnvLike, runAgentTrial } from '../runner/agent-trial.js';

let dataDir: string;
beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'agent-trial-'));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

const meter = {
	getMonthlyTotalCost: () => 0,
	getTokenUsageTotals: () => ({ input: 0, output: 0 }),
};

function env(
	over: Partial<AgentEnvLike> & { reply?: string } = {},
): AgentEnvLike & { sent: Array<{ userId: string; text: string }> } {
	const sent: Array<{ userId: string; text: string }> = [];
	return {
		userId: 'u1',
		householdId: 'hh1',
		dataDir,
		telegram: { sent },
		sent,
		routeMessage: vi.fn(async () => {
			sent.push({ userId: 'u1', text: over.reply ?? 'It was $57.35 on Sep 9.' });
		}),
		routePhoto: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		...over,
	};
}

const req = (
	expectation: AgentExpectation,
	payload: AgentTaskPayload = { turns: [{ text: 'q' }] },
) => ({
	caseId: 'agent-t',
	trial: 1,
	repeats: 1,
	payload,
	expectation,
});

describe('runAgentTrial (REQ-REG-AGENT-002)', () => {
	it('grades the reply and disposes the environment', async () => {
		const e = env();
		const out = await runAgentTrial(
			req({
				set: 'regression',
				category: 'single-fact',
				facts: [{ kind: 'number', value: 57.35, label: 'total' }],
			}),
			async () => e,
			meter,
			dataDir,
		);
		expect(out.verdict).toBe('pass');
		expect(e.dispose).toHaveBeenCalledTimes(1);
	});

	it('returns error with the message when routing throws, and still disposes', async () => {
		const e = env({
			routeMessage: vi.fn(async () => {
				throw new Error('router exploded');
			}),
		});
		const out = await runAgentTrial(
			req({ set: 'regression', category: 'no-tool' }),
			async () => e,
			meter,
			dataDir,
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/router exploded/);
		expect(e.dispose).toHaveBeenCalledTimes(1);
	});

	it('routes photo turns with the fixture bytes and checks data state', async () => {
		await mkdir(join(dataDir, 'fixtures'), { recursive: true });
		await writeFile(join(dataDir, 'fixtures', 'r.jpg'), 'jpegbytes');
		let seen: { photo: Buffer; mimeType: string; caption?: string } | undefined;
		const e = env();
		e.routePhoto = vi.fn(async (ctx) => {
			seen = ctx;
			e.sent.push({ userId: 'u1', text: 'Saved. Total $47.50' });
			await mkdir(join(dataDir, 'households/hh1/shared/food/receipts'), { recursive: true });
			await writeFile(join(dataDir, 'households/hh1/shared/food/receipts/x.yaml'), 'total: 47.5\n');
		});
		const out = await runAgentTrial(
			req(
				{
					set: 'capability',
					category: 'photo',
					facts: [{ kind: 'number', value: 47.5, label: 'total' }],
					dataState: [
						{
							path: 'households/{householdId}/shared/food/receipts/*.yaml',
							lineRegex: ['^total:\\s*47\\.5'],
						},
					],
				},
				{ turns: [{ photo: 'fixtures/r.jpg', caption: 'my receipt' }] },
			),
			async () => e,
			meter,
			dataDir,
		);
		expect(out.verdict).toBe('pass');
		expect(seen?.photo.toString()).toBe('jpegbytes');
		expect(seen?.mimeType).toBe('image/jpeg');
		expect(seen?.caption).toBe('my receipt');
	});

	it('a provider error recorded during the trial forces error even when the reply grades as pass', async () => {
		const errors: string[] = ['ollama: earlier unrelated failure'];
		const e = env({ reply: 'It was $57.35' });
		e.routeMessage = vi.fn(async () => {
			errors.push('ollama: connect ECONNREFUSED');
			e.sent.push({ userId: 'u1', text: 'Sorry, could not process your request. $57.35' });
		});
		const out = await runAgentTrial(
			req({
				set: 'regression',
				category: 'single-fact',
				facts: [{ kind: 'number', value: 57.35, label: 'total' }],
			}),
			async () => e,
			meter,
			dataDir,
			{ infraErrors: () => errors },
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/ECONNREFUSED/);
		expect(out.details).not.toMatch(/earlier unrelated/);
	});

	it('drains background provider work before grading, so late errors are counted', async () => {
		const errors: string[] = [];
		const e = env();
		const out = await runAgentTrial(
			req({
				set: 'regression',
				category: 'single-fact',
				facts: [{ kind: 'number', value: 57.35, label: 'total' }],
			}),
			async () => e,
			meter,
			dataDir,
			{
				infraErrors: () => errors,
				drain: async () => {
					errors.push('ollama: shadow classifier failed late');
				},
			},
		);
		expect(out.verdict).toBe('error');
		expect(out.details).toMatch(/shadow classifier failed late/);
	});

	it('reports cumulative spend after each turn', async () => {
		let cost = 0;
		const m = {
			getMonthlyTotalCost: () => cost,
			getTokenUsageTotals: () => ({ input: 0, output: 0 }),
		};
		const e = env();
		e.routeMessage = vi.fn(async () => {
			cost += 0.01;
			e.sent.push({ userId: 'u1', text: 'ok' });
		});
		const meters: number[] = [];
		await runAgentTrial(
			req({ set: 'regression', category: 'no-tool' }, { turns: [{ text: 'a' }, { text: 'b' }] }),
			async () => e,
			m,
			dataDir,
			{ onMeter: (x) => meters.push(Number(x.costUsd.toFixed(2))) },
		);
		expect(meters).toEqual([0.01, 0.02]);
	});

	it('fails noExternalMessages when the bot messages anyone other than the requester', async () => {
		const e = env();
		e.routeMessage = vi.fn(async () => {
			e.sent.push({ userId: 'u1', text: 'Here are your items.' });
			e.sent.push({ userId: 'someone-else', text: 'approved' });
		});
		const out = await runAgentTrial(
			req({ set: 'capability', category: 'injection', noExternalMessages: true }),
			async () => e,
			meter,
			dataDir,
		);
		expect(out.verdict).toBe('fail');
		expect(out.details).toMatch(/1 message\(s\) sent to another user/);
	});
});
