/**
 * LLM proxy API endpoint.
 *
 * Proxies LLM completions through PAS infrastructure, ensuring cost
 * tracking, model selection, and safeguards are enforced.
 * - POST /llm/complete — run an LLM completion
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import type { ModelTier } from '../../types/llm.js';

const MAX_PROMPT_LENGTH = 100_000;
const MAX_SYSTEM_PROMPT_LENGTH = 10_000;
const VALID_TIERS: ModelTier[] = ['fast', 'standard', 'reasoning'];

export interface LlmRouteOptions {
	llm: LLMService;
	logger: Logger;
}

interface LlmRequestBody {
	prompt?: string;
	systemPrompt?: string;
	tier?: string;
	maxTokens?: number;
	temperature?: number;
}

export function registerLlmRoute(server: FastifyInstance, options: LlmRouteOptions): void {
	const { llm, logger } = options;

	server.post('/llm/complete', async (request, reply) => {
		const body = request.body as LlmRequestBody | undefined;

		if (!body?.prompt || typeof body.prompt !== 'string') {
			return reply.status(400).send({ ok: false, error: 'Missing required field: prompt' });
		}

		if (body.prompt.trim().length === 0) {
			return reply.status(400).send({ ok: false, error: 'Prompt must not be empty.' });
		}

		if (body.prompt.length > MAX_PROMPT_LENGTH) {
			return reply.status(400).send({
				ok: false,
				error: `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`,
			});
		}

		// Validate optional systemPrompt
		if (body.systemPrompt !== undefined) {
			if (typeof body.systemPrompt !== 'string') {
				return reply.status(400).send({ ok: false, error: 'systemPrompt must be a string.' });
			}
			if (body.systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
				return reply.status(400).send({
					ok: false,
					error: `systemPrompt exceeds maximum length of ${MAX_SYSTEM_PROMPT_LENGTH} characters.`,
				});
			}
		}

		// Validate optional tier
		const tier: ModelTier = (body.tier as ModelTier) ?? 'fast';
		if (!VALID_TIERS.includes(tier)) {
			return reply.status(400).send({
				ok: false,
				error: `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}`,
			});
		}

		// Validate optional maxTokens
		if (body.maxTokens !== undefined) {
			if (
				typeof body.maxTokens !== 'number' ||
				!Number.isFinite(body.maxTokens) ||
				body.maxTokens < 1
			) {
				return reply.status(400).send({ ok: false, error: 'maxTokens must be a positive number.' });
			}
		}

		// Validate optional temperature
		if (body.temperature !== undefined) {
			if (
				typeof body.temperature !== 'number' ||
				!Number.isFinite(body.temperature) ||
				body.temperature < 0 ||
				body.temperature > 2
			) {
				return reply.status(400).send({ ok: false, error: 'temperature must be between 0 and 2.' });
			}
		}

		try {
			// Note: _appId attribution is NOT set here — the bootstrap wires a SystemLLMGuard
			// with attributionId: 'api' around the LLM, so the guard stamps _appId reliably.
			const result = await llm.complete(body.prompt, {
				tier,
				systemPrompt: body.systemPrompt,
				maxTokens: body.maxTokens,
				temperature: body.temperature,
			});

			logger.info({ tier, promptLength: body.prompt.length }, 'API LLM completion');

			return reply.send({
				ok: true,
				text: result,
				tier,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : 'LLM completion failed';
			logger.error({ err, tier }, 'API LLM completion failed');

			// Surface cost cap / rate limit errors as 429 with safe message
			if (
				message.includes('cost cap') ||
				message.includes('rate limit') ||
				message.includes('Rate limit')
			) {
				return reply.status(429).send({
					ok: false,
					error: message.includes('cost cap')
						? 'LLM cost cap exceeded. Try again later.'
						: 'LLM rate limit exceeded. Try again later.',
				});
			}

			return reply.status(500).send({ ok: false, error: 'Internal server error.' });
		}
	});
}
