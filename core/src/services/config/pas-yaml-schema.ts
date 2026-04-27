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
		api_key_env: z.string().min(1),
		base_url: z.string().optional(),
		default_model: z.string().optional(),
	})
	.passthrough();

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
