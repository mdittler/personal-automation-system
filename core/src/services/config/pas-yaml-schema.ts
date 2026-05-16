/**
 * Zod schema for config/pas.yaml validation.
 *
 * Validates the raw parsed YAML object before it is used to build SystemConfig.
 * Uses .passthrough() at the top level so unknown keys don't cause failures
 * (forward compatibility for future config additions).
 *
 * Throws a ZodError on invalid input — the caller should format and re-throw
 * as a startup error so the operator sees exactly what's wrong.
 */

import { z } from 'zod';
import { isLocalProvider } from '../llm/model-pricing.js';
import {
	IDLE_MINUTES_MAX,
	IDLE_MINUTES_MIN,
	RETENTION_DAYS_MAX,
	RETENTION_DAYS_MIN,
} from './settings-metadata.js';

const YamlUserSchema = z
	.object({
		id: z.string().min(1, 'User id must be a non-empty string'),
		name: z.string().min(1, 'User name must be a non-empty string'),
		is_admin: z.boolean().optional(),
		enabled_apps: z.array(z.string()).optional(),
		shared_scopes: z.array(z.string()).optional(),
	})
	.passthrough();

const YamlProviderConfigSchema = z
	.object({
		type: z.string().min(1),
		name: z.string().min(1),
		api_key_env: z.string().min(1).optional(),
		base_url: z.string().optional(),
		default_model: z.string().optional(),
	})
	.passthrough()
	.superRefine((data, ctx) => {
		if (!isLocalProvider(data.type) && !data.api_key_env) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['api_key_env'],
				message: `api_key_env is required for provider type "${data.type}"`,
			});
		}
	});

const YamlTierSchema = z
	.object({
		provider: z.string().min(1),
		model: z.string().min(1),
	})
	.passthrough();

const YamlLLMConfigSchema = z
	.object({
		providers: z.record(z.string(), YamlProviderConfigSchema).optional(),
		tiers: z
			.object({
				fast: YamlTierSchema.optional(),
				standard: YamlTierSchema.optional(),
				reasoning: YamlTierSchema.optional(),
			})
			.passthrough()
			.optional(),
		safeguards: z
			.object({
				default_rate_limit: z
					.object({
						max_requests: z.number().int().positive(),
						window_seconds: z.number().int().positive(),
					})
					.optional(),
				default_monthly_cost_cap: z.number().nonnegative().optional(),
				global_monthly_cost_cap: z.number().nonnegative().optional(),
				default_household_rate_limit: z
					.object({
						max_requests: z.number().int().positive(),
						window_seconds: z.number().int().positive(),
					})
					.optional(),
				default_household_monthly_cost_cap: z.number().nonnegative().optional(),
				household_overrides: z
					.record(
						z.string(),
						z.object({
							rate_limit: z
								.object({
									max_requests: z.number().int().positive(),
									window_seconds: z.number().int().positive(),
								})
								.optional(),
							monthly_cost_cap: z.number().nonnegative().optional(),
						}),
					)
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough()
	.optional();

const YamlWebhookConfigSchema = z
	.object({
		id: z.string().min(1),
		url: z.string().url('Webhook url must be a valid URL'),
		events: z.array(z.string()),
		secret: z.string().optional(),
	})
	.passthrough();

export const PasYamlConfigSchema = z
	.object({
		users: z.array(YamlUserSchema).optional(),
		defaults: z
			.object({
				log_level: z.string().optional(),
				timezone: z.string().optional(),
			})
			.passthrough()
			.optional(),
		llm: YamlLLMConfigSchema,
		webhooks: z.array(YamlWebhookConfigSchema).optional(),
		n8n: z
			.object({
				dispatch_url: z.string().optional(),
			})
			.passthrough()
			.optional(),
		routing: z
			.object({
				verification: z
					.object({
						enabled: z.boolean().optional(),
						upper_bound: z.number().optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		backup: z
			.object({
				enabled: z.boolean().optional(),
				path: z.string().optional(),
				schedule: z.string().optional(),
				retention_count: z.number().int().positive().optional(),
			})
			.passthrough()
			.optional(),
		chat: z
			.object({
				log_to_notes: z.boolean().optional(),
				memory: z
					.object({
						strict_durable_kinds: z.boolean().optional(),
					})
					.passthrough()
					.optional(),
				sessions: z
					.object({
						auto_prune: z.boolean().optional(),
						retention_days: z
							.number()
							.int('retention_days must be an integer')
							.min(RETENTION_DAYS_MIN, `retention_days must be at least ${RETENTION_DAYS_MIN}`)
							.max(RETENTION_DAYS_MAX, `retention_days must be at most ${RETENTION_DAYS_MAX}`)
							.optional(),
						auto_reset_idle_minutes: z
							.number()
							.int('auto_reset_idle_minutes must be an integer')
							.min(IDLE_MINUTES_MIN, `auto_reset_idle_minutes must be at least ${IDLE_MINUTES_MIN}`)
							.max(IDLE_MINUTES_MAX, `auto_reset_idle_minutes must be at most ${IDLE_MINUTES_MAX}`)
							.nullable()
							.optional(),
					})
					.passthrough()
					.optional(),
				recall: z
					.object({
						max_window_days: z
							.number()
							.int('chat.recall.max_window_days must be an integer')
							.min(1, 'chat.recall.max_window_days must be at least 1')
							.max(3650, 'chat.recall.max_window_days must be at most 3650 (10 years)')
							.optional(),
					})
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
		// Persona regression suite settings (REQ-REG-009).
		regression: z
			.object({
				maxRunBudgetUsd: z
					.number({ invalid_type_error: 'regression.maxRunBudgetUsd must be a number' })
					.finite('regression.maxRunBudgetUsd must be a finite number')
					.positive('regression.maxRunBudgetUsd must be a positive number')
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

/** Inferred type matching PasYamlConfigSchema */
export type PasYamlConfigInput = z.input<typeof PasYamlConfigSchema>;

/**
 * Parse and validate raw YAML content as pas.yaml config.
 * Throws a formatted Error (not ZodError) with a clear message on validation failure.
 */
export function parsePasYamlConfig(raw: unknown): PasYamlConfigInput {
	const result = PasYamlConfigSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('\n');
		throw new Error(`Invalid pas.yaml configuration:\n${issues}`);
	}
	return result.data;
}
