/**
 * LLM Usage & Model Management route.
 *
 * GET /gui/llm — Providers, tier assignments, available models, cost breakdown, usage log.
 * POST /gui/llm/tiers — Update tier assignment (provider + model).
 * POST /gui/llm/models — Legacy: update model selection (backward compat).
 * GET /gui/llm/available-models — htmx partial: available models grouped by provider.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { requirePlatformAdmin } from '../../gui/guards/require-platform-admin.js';
import { DEFAULT_LLM_SAFEGUARDS } from '../../services/config/defaults.js';
import type { HouseholdService } from '../../services/household/index.js';
import type { CostTracker } from '../../services/llm/cost-tracker.js';
import type { LLMServiceImpl } from '../../services/llm/index.js';
import type { ModelCatalog } from '../../services/llm/model-catalog.js';
import {
	DEFAULT_REMOTE_PRICING,
	MODEL_PRICING,
	getModelPricing,
} from '../../services/llm/model-pricing.js';
import type { ModelSelector } from '../../services/llm/model-selector.js';
import type { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';
import type { MessageRateTracker } from '../../services/metrics/message-rate-tracker.js';
import type { LLMSafeguardsConfig } from '../../types/config.js';
import type { ModelRef, ModelTier } from '../../types/llm.js';

export interface LlmUsageOptions {
	llm: LLMServiceImpl;
	modelSelector: ModelSelector;
	modelCatalog: ModelCatalog;
	providerRegistry: ProviderRegistry;
	logger: Logger;
	/** Cost tracker for live per-household monthly costs (includes reservations). */
	costTracker?: CostTracker;
	/** Household service for member counts. */
	householdService?: Pick<HouseholdService, 'listHouseholds' | 'getMembers'>;
	/** Message rate tracker for live ops metrics. */
	messageRateTracker?: MessageRateTracker;
	/** LLM safeguards config for displaying per-household caps. */
	llmSafeguards?: LLMSafeguardsConfig;
}

export interface UsageRow {
	timestamp: string;
	provider: string;
	model: string;
	inputTokens: string;
	outputTokens: string;
	cost: string;
	app: string;
	user: string;
}

export interface UserBreakdown {
	userId: string;
	callCount: number;
	totalCost: number;
}

export interface ModelBreakdown {
	provider: string;
	model: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCost: number;
	callCount: number;
}

export interface HouseholdBreakdown {
	householdId: string;
	callCount: number;
	totalCost: number;
}

export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function parseUsageMarkdown(content: string): {
	rows: UsageRow[];
	todayCost: number;
	monthCost: number;
	totalCost: number;
	perModel: ModelBreakdown[];
	perUser: UserBreakdown[];
	perHousehold: HouseholdBreakdown[];
} {
	const lines = content.trim().split('\n');
	const rows: UsageRow[] = [];
	let totalCost = 0;
	let todayCost = 0;
	let monthCost = 0;
	const modelMap = new Map<string, ModelBreakdown>();
	const userMap = new Map<string, UserBreakdown>();
	const householdMap = new Map<string, HouseholdBreakdown>();

	const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
	const today = new Date().toISOString().slice(0, 10);
	const thisMonth = new Date().toISOString().slice(0, 7);

	for (const line of lines) {
		if (!line.startsWith('|') || line.includes('---') || line.includes('Timestamp')) {
			continue;
		}

		const cells = line
			.split('|')
			.map((c) => c.trim())
			.filter(Boolean);
		if (cells.length < 6) continue;

		// Support 6-col, 7-col (+ Provider), 8-col (+ User), and 9-col (+ Household) formats
		const hasHousehold = cells.length >= 9;
		const hasUser = cells.length >= 8;
		const hasProvider = cells.length >= 7;
		const timestamp = cells[0] ?? '';
		const provider = hasProvider ? (cells[1] ?? '-') : '-';
		const model = hasProvider ? (cells[2] ?? '') : (cells[1] ?? '');
		const inputTokens = hasProvider ? (cells[3] ?? '') : (cells[2] ?? '');
		const outputTokens = hasProvider ? (cells[4] ?? '') : (cells[3] ?? '');
		const cost = hasProvider ? (cells[5] ?? '') : (cells[4] ?? '');
		const app = hasProvider ? (cells[6] ?? '') : (cells[5] ?? '');
		const user = hasUser ? (cells[7] ?? '-') : '-';
		const household = hasHousehold ? (cells[8] ?? '-') : '-';
		const costNum = Number.parseFloat(cost) || 0;
		const inputNum = Number.parseInt(inputTokens, 10) || 0;
		const outputNum = Number.parseInt(outputTokens, 10) || 0;

		rows.push({ timestamp, provider, model, inputTokens, outputTokens, cost, app, user });
		totalCost = round6(totalCost + costNum);

		if (timestamp.startsWith(today)) todayCost = round6(todayCost + costNum);
		if (timestamp.startsWith(thisMonth)) monthCost = round6(monthCost + costNum);

		// Per-model aggregation (keyed by provider:model)
		const key = `${provider}:${model}`;
		let breakdown = modelMap.get(key);
		if (!breakdown) {
			breakdown = {
				provider,
				model,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				totalCost: 0,
				callCount: 0,
			};
			modelMap.set(key, breakdown);
		}
		breakdown.totalInputTokens += inputNum;
		breakdown.totalOutputTokens += outputNum;
		breakdown.totalCost = round6(breakdown.totalCost + costNum);
		breakdown.callCount += 1;

		// Per-user aggregation
		if (user && user !== '-') {
			let userBreakdown = userMap.get(user);
			if (!userBreakdown) {
				userBreakdown = { userId: user, callCount: 0, totalCost: 0 };
				userMap.set(user, userBreakdown);
			}
			userBreakdown.callCount += 1;
			userBreakdown.totalCost = round6(userBreakdown.totalCost + costNum);
		}

		// Per-household aggregation (9-col rows only; '-' and '__platform__' excluded)
		if (household && household !== '-' && household !== '__platform__') {
			let hhBreakdown = householdMap.get(household);
			if (!hhBreakdown) {
				hhBreakdown = { householdId: household, callCount: 0, totalCost: 0 };
				householdMap.set(household, hhBreakdown);
			}
			hhBreakdown.callCount += 1;
			hhBreakdown.totalCost = round6(hhBreakdown.totalCost + costNum);
		}
	}

	// Sort per-model by cost descending
	const perModel = [...modelMap.values()].sort((a, b) => b.totalCost - a.totalCost);
	// Sort per-user by cost descending
	const perUser = [...userMap.values()].sort((a, b) => b.totalCost - a.totalCost);
	// Sort per-household by cost descending
	const perHousehold = [...householdMap.values()].sort((a, b) => b.totalCost - a.totalCost);

	return { rows: rows.reverse(), todayCost, monthCost, totalCost, perModel, perUser, perHousehold };
}

export interface PerHouseholdRow {
	householdId: string;
	householdName: string;
	memberCount: number;
	callCount: number;
	monthlyCost: number;
	cap: number;
	pctOfCap: number;
	overCap: boolean;
}

function buildPerHouseholdRows(
	usageContent: string,
	costTracker: CostTracker | undefined,
	householdService: Pick<HouseholdService, 'listHouseholds' | 'getMembers'> | undefined,
	llmSafeguards: LLMSafeguardsConfig | undefined,
): PerHouseholdRow[] {
	if (!householdService) return [];

	const defaultCap =
		llmSafeguards?.defaultHouseholdMonthlyCostCap ??
		DEFAULT_LLM_SAFEGUARDS.defaultHouseholdMonthlyCostCap;

	// Parse log for call counts per household
	const callCounts = new Map<string, number>();
	if (usageContent.trim()) {
		const { perHousehold } = parseUsageMarkdown(usageContent);
		for (const h of perHousehold) {
			callCounts.set(h.householdId, h.callCount);
		}
	}

	const rows: PerHouseholdRow[] = [];
	for (const hh of householdService.listHouseholds()) {
		const monthlyCost = costTracker?.getMonthlyHouseholdCost(hh.id) ?? 0;
		const cap = llmSafeguards?.householdOverrides?.[hh.id]?.monthlyCostCap ?? defaultCap;
		const pctOfCap = cap > 0 ? Math.round((monthlyCost / cap) * 100) : 0;
		const members = householdService.getMembers(hh.id);
		rows.push({
			householdId: hh.id,
			householdName: hh.name,
			memberCount: members.length,
			callCount: callCounts.get(hh.id) ?? 0,
			monthlyCost,
			cap,
			pctOfCap,
			overCap: pctOfCap >= 100,
		});
	}

	return rows.sort((a, b) => b.monthlyCost - a.monthlyCost);
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,100}$/;
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,50}$/;
const VALID_TIERS: ReadonlySet<string> = new Set(['fast', 'standard', 'reasoning']);

function isModelRefActive(model: { id: string; provider?: string }, ref: ModelRef): boolean {
	return model.id === ref.model && (model.provider ?? '') === ref.provider;
}

export function registerLlmUsageRoutes(server: FastifyInstance, options: LlmUsageOptions): void {
	const {
		llm,
		modelSelector,
		modelCatalog,
		providerRegistry,
		logger,
		costTracker,
		householdService,
		messageRateTracker,
		llmSafeguards,
	} = options;

	// D5b-4: platform-admin gate
	server.addHook('preHandler', requirePlatformAdmin);

	// Main LLM page
	server.get('/llm', async (_request: FastifyRequest, reply: FastifyReply) => {
		const content = await llm.costTracker.readUsage();
		const standardRef = modelSelector.getStandardRef();
		const fastRef = modelSelector.getFastRef();
		const reasoningRef = modelSelector.getReasoningRef();

		// Provider list
		const providers = providerRegistry.getAll().map((p) => ({
			id: p.providerId,
			type: p.providerType,
		}));

		// Live ops metrics
		const activeHouseholds = messageRateTracker?.getActiveHouseholds() ?? 0;
		const messagesPerMinute = messageRateTracker?.getMessagesPerMinute() ?? 0;

		// Per-household breakdown combining live monthly costs + log call counts + member counts
		const perHouseholdRows = buildPerHouseholdRows(
			content,
			costTracker,
			householdService,
			llmSafeguards,
		);

		if (!content.trim()) {
			return reply.viewAsync('llm-usage', {
				title: 'LLM — PAS',
				activePage: 'llm',
				standardRef,
				fastRef,
				reasoningRef,
				providers,
				rows: [],
				perModel: [],
				perUser: [],
				perHouseholdRows,
				todayCost: '0.000000',
				monthCost: '0.000000',
				totalCost: '0.000000',
				hasData: false,
				activeHouseholds,
				messagesPerMinute,
			});
		}

		const { rows, todayCost, monthCost, totalCost, perModel, perUser } =
			parseUsageMarkdown(content);

		return reply.viewAsync('llm-usage', {
			title: 'LLM — PAS',
			activePage: 'llm',
			standardRef,
			fastRef,
			reasoningRef,
			providers,
			rows,
			perModel,
			perUser,
			perHouseholdRows,
			todayCost: todayCost.toFixed(6),
			monthCost: monthCost.toFixed(6),
			totalCost: totalCost.toFixed(6),
			hasData: true,
			activeHouseholds,
			messagesPerMinute,
		});
	});

	// htmx partial: live metrics (polled every 5s by the Live card)
	server.get('/llm/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
		const active = messageRateTracker?.getActiveHouseholds() ?? 0;
		const rpm = messageRateTracker?.getMessagesPerMinute() ?? 0;
		const html =
			`<span id="live-active-households">${escapeHtml(String(active))}</span> active household${active !== 1 ? 's' : ''} &mdash; ` +
			`<span id="live-rpm">${escapeHtml(String(rpm))}</span> msg/min`;
		return reply.type('text/html').send(html);
	});

	// Update tier assignment (new multi-provider route)
	server.post<{
		Body: { tier?: string; provider?: string; model?: string };
	}>('/llm/tiers', async (request, reply) => {
		const { tier, provider, model } = request.body;

		if (!tier || typeof tier !== 'string' || !VALID_TIERS.has(tier)) {
			return reply.status(400).send('Invalid tier. Must be fast, standard, or reasoning.');
		}

		if (!provider || typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider.trim())) {
			return reply.status(400).send('Invalid provider ID');
		}

		if (!model || typeof model !== 'string' || !MODEL_ID_PATTERN.test(model.trim())) {
			return reply.status(400).send('Invalid model ID');
		}

		if (!providerRegistry.has(provider.trim())) {
			return reply.status(400).send('Unknown provider');
		}

		const ref: ModelRef = { provider: provider.trim(), model: model.trim() };

		switch (tier as ModelTier) {
			case 'fast':
				await modelSelector.setFastRef(ref);
				break;
			case 'standard':
				await modelSelector.setStandardRef(ref);
				break;
			case 'reasoning':
				await modelSelector.setReasoningRef(ref);
				break;
		}

		logger.info({ tier, ref }, 'Tier assignment updated via GUI');

		reply.header('HX-Refresh', 'true');
		return reply.status(204).send();
	});

	// Legacy: update model selection (backward compat)
	server.post<{
		Body: { standardModel?: string; fastModel?: string };
	}>('/llm/models', async (request, reply) => {
		const { standardModel, fastModel } = request.body;

		if (standardModel && typeof standardModel === 'string' && standardModel.trim()) {
			if (!MODEL_ID_PATTERN.test(standardModel.trim())) {
				return reply.status(400).send('Invalid model ID');
			}
			await modelSelector.setStandardModel(standardModel.trim());
			logger.info({ standardModel: standardModel.trim() }, 'Standard model updated via GUI');
		}

		if (fastModel && typeof fastModel === 'string' && fastModel.trim()) {
			if (!MODEL_ID_PATTERN.test(fastModel.trim())) {
				return reply.status(400).send('Invalid model ID');
			}
			await modelSelector.setFastModel(fastModel.trim());
			logger.info({ fastModel: fastModel.trim() }, 'Fast model updated via GUI');
		}

		reply.header('HX-Refresh', 'true');
		return reply.status(204).send();
	});

	// Available models (htmx partial, lazy-loaded, grouped by provider)
	server.get('/llm/available-models', async (_request: FastifyRequest, reply: FastifyReply) => {
		try {
			const models = await modelCatalog.getModels();
			const standardRef = modelSelector.getStandardRef();
			const fastRef = modelSelector.getFastRef();
			const reasoningRef = modelSelector.getReasoningRef();

			// Group models by provider
			const byProvider = new Map<string, typeof models>();
			for (const model of models) {
				const key = model.provider ?? 'unknown';
				if (!byProvider.has(key)) byProvider.set(key, []);
				byProvider.get(key)?.push(model);
			}

			// Add pricing-table models not in catalog, grouped by provider
			const catalogModelKeys = new Set(models.map((m) => `${m.provider ?? ''}:${m.id}`));
			for (const [modelId, pricing] of Object.entries(MODEL_PRICING)) {
				// These have no provider info — group under "other"
				if (!catalogModelKeys.has(`:${modelId}`) && !models.some((m) => m.id === modelId)) {
					if (!byProvider.has('other')) byProvider.set('other', []);
					byProvider.get('other')?.push({
						id: modelId,
						displayName: 'not in API',
						createdAt: '',
						pricing,
						provider: 'other',
						providerType: undefined,
					});
				}
			}

			let html = '';

			for (const [providerId, providerModels] of byProvider) {
				const safeProvider = escapeHtml(providerId);
				html += `<h4>${safeProvider}</h4>`;
				html += '<table><thead><tr>';
				html += '<th>Model ID</th><th>Display Name</th>';
				html += '<th>Input $/M</th><th>Output $/M</th>';
				html += '<th>Standard</th><th>Fast</th><th>Reasoning</th>';
				html += '</tr></thead><tbody>';

				for (const model of providerModels) {
					const safeId = escapeHtml(model.id);
					const safeName = escapeHtml(model.displayName);

					// Show the pricing that CostTracker will actually use for this model:
					// catalog pricing > MODEL_PRICING table > DEFAULT_REMOTE_PRICING (for non-Ollama)
					const isOllama = model.providerType === 'ollama';
					const knownPricing = model.pricing ?? getModelPricing(model.id);
					let inputPrice: string;
					let outputPrice: string;
					if (isOllama) {
						inputPrice = '$0.00';
						outputPrice = '$0.00';
					} else if (knownPricing) {
						inputPrice = `$${knownPricing.input.toFixed(2)}`;
						outputPrice = `$${knownPricing.output.toFixed(2)}`;
					} else {
						// No exact pricing — CostTracker falls back to DEFAULT_REMOTE_PRICING
						inputPrice = `~$${DEFAULT_REMOTE_PRICING.input.toFixed(2)} <small title="No exact pricing — using conservative fallback estimate">(est.)</small>`;
						outputPrice = `~$${DEFAULT_REMOTE_PRICING.output.toFixed(2)} <small title="No exact pricing — using conservative fallback estimate">(est.)</small>`;
					}

					const isStandard = isModelRefActive(model, standardRef);
					const isFast = isModelRefActive(model, fastRef);
					const isReasoning = reasoningRef ? isModelRefActive(model, reasoningRef) : false;

					const btnStyle = 'style="padding:0.15rem 0.4rem;margin:0;font-size:0.75rem"';
					const modelProvider = model.provider ?? providerId;

					const standardBtn = isStandard
						? '<span class="status-ok">Active</span>'
						: `<button class="outline" ${btnStyle} hx-post="/gui/llm/tiers" hx-vals='${escapeHtml(JSON.stringify({ tier: 'standard', provider: modelProvider, model: model.id }))}' hx-swap="none" hx-confirm="Set ${safeId} as standard model?">Set</button>`;

					const fastBtn = isFast
						? '<span class="status-ok">Active</span>'
						: `<button class="outline" ${btnStyle} hx-post="/gui/llm/tiers" hx-vals='${escapeHtml(JSON.stringify({ tier: 'fast', provider: modelProvider, model: model.id }))}' hx-swap="none" hx-confirm="Set ${safeId} as fast model?">Set</button>`;

					const reasoningBtn = isReasoning
						? '<span class="status-ok">Active</span>'
						: `<button class="outline" ${btnStyle} hx-post="/gui/llm/tiers" hx-vals='${escapeHtml(JSON.stringify({ tier: 'reasoning', provider: modelProvider, model: model.id }))}' hx-swap="none" hx-confirm="Set ${safeId} as reasoning model?">Set</button>`;

					html += `<tr><td><code>${safeId}</code></td><td>${safeName}</td>`;
					html += `<td>${inputPrice}</td><td>${outputPrice}</td>`;
					html += `<td>${standardBtn}</td><td>${fastBtn}</td><td>${reasoningBtn}</td></tr>`;
				}

				html += '</tbody></table>';
			}

			if (byProvider.size === 0) {
				html = '<p>No models available. Check your provider configuration and API keys.</p>';
			}

			return reply.type('text/html').send(html);
		} catch (err) {
			logger.error(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to load available models',
			);
			return reply
				.type('text/html')
				.send('<p class="status-err">Failed to load available models. Check your API keys.</p>');
		}
	});
}
