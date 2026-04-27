/**
 * System-introspection helpers for the chatbot's app-aware prompt.
 *
 * Categorize a question, then gather live system data (LLM tiers, costs,
 * scheduled jobs, system status, user data overview) into a compact text
 * block. Each category degrades gracefully — a thrown error in one section
 * does not affect the others.
 */

import type { AppMetadataService } from '../../types/app-metadata.js';
import type { AppLogger } from '../../types/app-module.js';
import type { DataStoreService } from '../../types/data-store.js';
import type { SystemInfoService } from '../../types/system-info.js';

/** Question category type. */
export type QuestionCategory = 'llm' | 'costs' | 'scheduling' | 'system' | 'data';

/** Keywords for each question category. */
export const CATEGORY_KEYWORDS: Record<QuestionCategory, string[]> = {
	llm: [
		'model',
		'models',
		'provider',
		'providers',
		'tier',
		'tiers',
		'switch',
		'change model',
		'fast model',
		'standard model',
		'reasoning model',
		'what model',
		'which model',
		'pricing',
		'price',
		'per token',
		'per million',
		'available models',
	],
	costs: [
		'cost',
		'costs',
		'spending',
		'spent',
		'usage',
		'tokens',
		'budget',
		'cost cap',
		'how much',
		'monthly',
		'bill',
	],
	scheduling: ['schedule', 'scheduling', 'cron', 'jobs', 'scheduled', 'daily diff'],
	system: [
		'uptime',
		'status',
		'rate limit',
		'safeguard',
		'how many apps',
		'how many users',
		'timezone',
	],
	data: [
		'what did i',
		'what have i',
		'show my',
		'my data',
		'my notes',
		'my files',
		'grocery',
		'groceries',
		'recipe',
		'recipes',
		'meal',
		'meals',
		'fitness',
		'workout',
		'exercise',
		'recent activity',
		'recent changes',
		'what changed',
		'data files',
		'what data',
	],
};

/** Max available models to include in prompt. */
const MAX_AVAILABLE_MODELS = 30;

/**
 * Categorize a question into data domains for system info gathering.
 * Keyword-based — no LLM cost.
 */
export function categorizeQuestion(text: string): Set<QuestionCategory> {
	const categories = new Set<QuestionCategory>();
	const lower = text.toLowerCase();

	for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
		for (const keyword of keywords) {
			if (lower.includes(keyword)) {
				categories.add(category as QuestionCategory);
				break;
			}
		}
	}

	return categories;
}

/** Format uptime seconds into a human-readable string. */
export function formatUptime(seconds: number): string {
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	parts.push(`${mins}m`);
	return parts.join(' ');
}

/**
 * Gather an overview of the user's data.
 *
 * Lists the chatbot's own daily notes (what we can access via our scoped
 * store) plus installed app metadata showing what data capabilities exist.
 */
export async function gatherUserDataOverview(
	userId: string,
	deps: { data?: DataStoreService; appMetadata?: AppMetadataService; logger?: AppLogger },
): Promise<string> {
	const lines: string[] = [];

	// List chatbot's own daily notes (files we CAN access)
	if (deps.data) {
		try {
			const store = deps.data.forUser(userId);
			const noteFiles = await store.list('daily-notes');
			if (noteFiles.length > 0) {
				lines.push('Your recent daily notes:');
				const recent = noteFiles.slice(-10);
				for (const file of recent) {
					lines.push(`  daily-notes/${file}`);
				}
				if (noteFiles.length > 10) {
					lines.push(`  ... and ${noteFiles.length - 10} older files`);
				}
			}
		} catch {
			// No daily notes directory yet
		}
	}

	// List installed apps with data-related capabilities
	const apps = deps.appMetadata ? deps.appMetadata.getInstalledApps() : [];
	if (apps.length > 0) {
		const dataApps = apps.filter((a) => a.commands.length > 0 || a.intents.length > 0);
		if (dataApps.length > 0) {
			lines.push('Installed apps that may have data:');
			for (const app of dataApps) {
				const capabilities: string[] = [];
				if (app.commands.length > 0) {
					capabilities.push(`commands: ${app.commands.map((c) => c.name).join(', ')}`);
				}
				if (app.intents.length > 0) {
					capabilities.push(`understands: ${app.intents.join(', ')}`);
				}
				lines.push(`  ${app.name} (${app.id}) — ${capabilities.join('; ')}`);
			}
			lines.push(
				'Note: Each app stores data in its own directory (data/users/<userId>/<appId>/). ' +
					'Use natural language to query your data (e.g., "what are my Costco prices?").',
			);
		}
	}

	return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Gather live system data based on detected question categories.
 *
 * Returns formatted text for prompt injection, or empty string if no data.
 *
 * Signature matches the legacy chatbot helper so existing call sites and
 * tests remain stable. Optional `dataDeps` parameter carries data-store and
 * app-metadata services used for the "data" category overview.
 *
 * @param systemInfo  Required.
 * @param categories  Categories detected by `categorizeQuestion`.
 * @param question    The user's original question (used for sub-category tweaks).
 * @param userId      Current user (for per-user cost line, data overview).
 * @param isAdmin     Whether the current user has admin privileges.
 * @param dataDeps    Optional — additional services for the "data" category.
 */
export async function gatherSystemData(
	systemInfo: SystemInfoService,
	categories: Set<QuestionCategory>,
	question: string,
	userId?: string,
	isAdmin?: boolean,
	dataDeps?: {
		data?: DataStoreService;
		appMetadata?: AppMetadataService;
		logger?: AppLogger;
	},
): Promise<string> {
	const sections: string[] = [];

	if (categories.has('llm')) {
		try {
			// Tier assignments
			const tiers = systemInfo.getTierAssignments();
			sections.push('Active model tiers:');
			for (const t of tiers) {
				const pricing = isAdmin ? systemInfo.getModelPricing(t.model) : null;
				const priceStr = pricing
					? ` (input: $${pricing.inputPerMillion}/M tokens, output: $${pricing.outputPerMillion}/M tokens)`
					: '';
				const modelLabel = isAdmin ? `${t.provider}/${t.model}` : t.model;
				sections.push(`  ${t.tier}: ${modelLabel}${priceStr}`);
			}

			// Providers — admin only
			if (isAdmin) {
				const providers = systemInfo.getProviders();
				sections.push(
					`Configured providers: ${providers.map((p) => `${p.id} (${p.type})`).join(', ')}`,
				);
			}

			// Available models (only when question seems to ask about switching/listing). Admin only.
			if (isAdmin) {
				const lower = question.toLowerCase();
				if (
					lower.includes('available') ||
					lower.includes('switch') ||
					lower.includes('change') ||
					lower.includes('list')
				) {
					try {
						const models = await systemInfo.getAvailableModels();
						if (models.length > 0) {
							sections.push(
								`Available models (${models.length} total, showing up to ${MAX_AVAILABLE_MODELS}):`,
							);
							for (const m of models.slice(0, MAX_AVAILABLE_MODELS)) {
								const pricing = systemInfo.getModelPricing(m.id);
								const priceStr = pricing
									? ` ($${pricing.inputPerMillion}/$${pricing.outputPerMillion} per M tokens)`
									: '';
								sections.push(`  ${m.provider}/${m.id}${priceStr}`);
							}
						}
					} catch {
						// Catalog fetch failed, skip
					}
				}
			}
		} catch {
			// LLM data fetch failed, skip
		}
	}

	if (categories.has('costs')) {
		try {
			const costs = systemInfo.getCostSummary();
			sections.push(`Monthly costs (${costs.month}):`);
			sections.push(`  Total: $${costs.monthlyTotal.toFixed(4)}`);

			if (isAdmin) {
				const appEntries = Object.entries(costs.perApp);
				if (appEntries.length > 0) {
					sections.push('  Per app:');
					for (const [appId, cost] of appEntries) {
						sections.push(`    ${appId}: $${cost.toFixed(4)}`);
					}
				} else {
					sections.push('  No per-app costs recorded yet.');
				}

				const userEntries = Object.entries(costs.perUser);
				if (userEntries.length > 0) {
					sections.push('  Per user:');
					for (const [uid, cost] of userEntries) {
						const marker = uid === userId ? ' (this user)' : '';
						sections.push(`    ${uid}${marker}: $${cost.toFixed(4)}`);
					}
				}
			} else {
				if (userId && costs.perUser[userId] !== undefined) {
					sections.push('  Your usage:');
					sections.push(`    ${userId} (this user): $${costs.perUser[userId].toFixed(4)}`);
				}
			}

			// Per-model pricing for active models — admin only
			if (isAdmin) {
				const tiers = systemInfo.getTierAssignments();
				const pricedModels = new Set<string>();
				for (const t of tiers) {
					if (pricedModels.has(t.model)) continue;
					pricedModels.add(t.model);
					const pricing = systemInfo.getModelPricing(t.model);
					if (pricing) {
						sections.push(
							`  ${t.model} pricing: $${pricing.inputPerMillion}/M input, $${pricing.outputPerMillion}/M output`,
						);
					}
				}
			}
		} catch {
			// Cost data fetch failed, skip
		}
	}

	if (categories.has('scheduling') && isAdmin) {
		try {
			const jobs = systemInfo.getScheduledJobs();
			if (jobs.length > 0) {
				sections.push(`Scheduled cron jobs (${jobs.length}):`);
				for (const job of jobs) {
					const desc = job.description ? ` — ${job.description}` : '';
					sections.push(`  ${job.key} [${job.cron}]${desc}`);
				}
			} else {
				sections.push('No scheduled cron jobs.');
			}
		} catch {
			// Scheduling data fetch failed, skip
		}
	}

	if (categories.has('system')) {
		try {
			const status = systemInfo.getSystemStatus();
			const uptimeStr = formatUptime(status.uptimeSeconds);
			sections.push('System status:');
			sections.push(`  Uptime: ${uptimeStr}`);
			sections.push(`  Apps loaded: ${status.appCount}`);
			sections.push(`  Timezone: ${status.timezone}`);

			if (isAdmin) {
				sections.push(`  Users: ${status.userCount}`);
				sections.push(`  Cron jobs: ${status.cronJobCount}`);

				const safeguards = systemInfo.getSafeguardDefaults();
				sections.push('LLM safeguard defaults:');
				sections.push(
					`  Rate limit: ${safeguards.rateLimit.maxRequests} requests per ${safeguards.rateLimit.windowSeconds}s`,
				);
				sections.push(`  Per-app monthly cost cap: $${safeguards.appMonthlyCostCap}`);
				sections.push(`  Global monthly cost cap: $${safeguards.globalMonthlyCostCap}`);
			}
		} catch {
			// System status fetch failed, skip
		}
	}

	if (categories.has('data') && userId) {
		try {
			const dataOverview = await gatherUserDataOverview(userId, {
				...(dataDeps?.data !== undefined ? { data: dataDeps.data } : {}),
				...(dataDeps?.appMetadata !== undefined ? { appMetadata: dataDeps.appMetadata } : {}),
				...(dataDeps?.logger !== undefined ? { logger: dataDeps.logger } : {}),
			});
			if (dataOverview) {
				sections.push(dataOverview);
			}
		} catch {
			// Data overview fetch failed, skip
		}
	}

	return sections.join('\n');
}
