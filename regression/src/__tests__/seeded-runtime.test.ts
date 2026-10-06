import type { SystemConfig } from '@core/types/config.js';
import { describe, expect, it } from 'vitest';
import { buildSeededConfig } from '../runner/seeded-runtime.js';

function realConfig(): SystemConfig {
	return {
		dataDir: '/prod/data',
		timezone: 'UTC',
		users: [],
		telegram: { botToken: 'real-token' },
		gui: { authToken: 'real-gui' },
		api: { token: 'real-api' },
		webhooks: [{ id: 'w', url: 'https://prod.example/hook', events: ['*'], secret: 's' }],
		n8n: { dispatchUrl: 'https://n8n.prod.example/webhook' },
		llm: {
			providers: {},
			tiers: {
				fast: { provider: 'a', model: 'fast-real' },
				standard: { provider: 'a', model: 'std-real' },
				reasoning: { provider: 'a', model: 'reason-real' },
			},
			safeguards: {
				defaultRateLimit: { maxRequests: 10, windowSeconds: 60 },
				defaultMonthlyCostCap: 1,
				globalMonthlyCostCap: 2,
				defaultHouseholdRateLimit: { maxRequests: 10, windowSeconds: 60 },
				defaultHouseholdMonthlyCostCap: 1,
				householdOverrides: { hh: { monthlyCostCap: 0.01 } },
			},
		},
	} as unknown as SystemConfig;
}

const base = { dataDir: '/tmp/seeded/data', users: [] };

describe('buildSeededConfig (REQ-REG-025)', () => {
	it('strips outbound webhooks so a trial can never fire a real integration', () => {
		expect(buildSeededConfig(realConfig(), base).webhooks).toEqual([]);
	});

	it('empties the n8n dispatch url', () => {
		expect(buildSeededConfig(realConfig(), base).n8n.dispatchUrl).toBe('');
	});

	it('replaces production safeguards with caps the run budget outranks', () => {
		const sg = buildSeededConfig(realConfig(), base).llm?.safeguards;
		expect(sg).toEqual({
			defaultRateLimit: { maxRequests: 100_000, windowSeconds: 3600 },
			defaultMonthlyCostCap: 1_000,
			globalMonthlyCostCap: 1_000,
			defaultHouseholdRateLimit: { maxRequests: 100_000, windowSeconds: 3600 },
			defaultHouseholdMonthlyCostCap: 1_000,
		});
	});

	it('points at the temp data dir with stub credentials', () => {
		const c = buildSeededConfig(realConfig(), base);
		expect(c.dataDir).toBe('/tmp/seeded/data');
		expect(c.telegram.botToken).toBe('regression-stub');
		expect(c.gui.authToken).toBe('regression-stub');
		expect(c.api.token).toBe('regression-stub');
	});

	it('applies tier overrides and keeps unspecified tiers', () => {
		const c = buildSeededConfig(realConfig(), {
			...base,
			tierOverride: { fast: { provider: 'b', model: 'fast-new' } },
		});
		expect(c.llm?.tiers.fast).toEqual({ provider: 'b', model: 'fast-new' });
		expect(c.llm?.tiers.standard.model).toBe('std-real');
	});

	it('reasoning falls through to the production reasoning tier when not overridden', () => {
		const c = buildSeededConfig(realConfig(), {
			...base,
			tierOverride: { standard: { provider: 'b', model: 'std-new' } },
		});
		expect(c.llm?.tiers.reasoning?.model).toBe('reason-real');
		const o = buildSeededConfig(realConfig(), {
			...base,
			tierOverride: { reasoning: { provider: 'b', model: 'reason-new' } },
		});
		expect(o.llm?.tiers.reasoning?.model).toBe('reason-new');
	});

	it('omits reasoning when neither override nor production defines it', () => {
		const cfg = realConfig();
		if (cfg.llm) cfg.llm.tiers.reasoning = undefined;
		const c = buildSeededConfig(cfg, { ...base, tierOverride: {} });
		expect(c.llm?.tiers.reasoning).toBeUndefined();
	});

	it('throws when a tier override is requested but pas.yaml has no llm config', () => {
		const cfg = realConfig();
		cfg.llm = undefined;
		expect(() =>
			buildSeededConfig(cfg, { ...base, tierOverride: { fast: { provider: 'x', model: 'y' } } }),
		).toThrow(/requires llm config/);
	});
});
