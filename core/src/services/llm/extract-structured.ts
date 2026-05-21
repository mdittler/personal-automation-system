/**
 * Structured data extraction using an LLM.
 *
 * Sends a JSON schema and asks the LLM to produce matching output.
 * Works with any LLMClient (Ollama or Claude).
 */

import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Logger } from 'pino';
import type { LLMClient } from '../../types/llm.js';
import { buildExtractPrompt } from './prompt-templates.js';

const ajv = new AjvModule.default();

/**
 * Memoization cache for compiled AJV validators, keyed by schema object
 * identity. `ajv.compile()` is expensive; callers pass stable module-level
 * schema constants, so identity keying gives a correct, collision-free hit.
 */
const validatorCache = new WeakMap<object, ValidateFunction>();

/**
 * Return a compiled AJV validator for `schema`, memoized by object identity.
 *
 * The cache is keyed on the schema **object reference** via a `WeakMap`, which
 * is correct and collision-free for the expected pattern: callers hold a stable
 * module-level schema constant and pass the same object on every call. Two
 * structurally-identical but distinct objects are distinct keys and therefore
 * compile to distinct validators — this is intentional, not a bug.
 *
 * A schema object is treated as **immutable after its first validation**:
 * mutating a schema in place after it has been cached yields the stale cached
 * validator rather than a recompiled one. Treat schema objects as frozen once
 * passed to `getValidator`/`extractStructured`.
 */
export function getValidator(schema: object): ValidateFunction {
	let validate = validatorCache.get(schema);
	if (validate === undefined) {
		validate = ajv.compile(schema);
		validatorCache.set(schema, validate);
	}
	return validate;
}

/**
 * Extract structured data from text according to a JSON schema.
 *
 * @param text - The text to extract data from
 * @param schema - JSON schema describing the expected output
 * @param client - LLM client (Ollama or Claude)
 * @param logger - Logger instance
 * @returns Parsed object matching the schema
 * @throws Error if the LLM response cannot be parsed as valid JSON
 */
export async function extractStructured<T>(
	text: string,
	schema: object,
	client: LLMClient,
	logger: Logger,
): Promise<T> {
	const prompt = buildExtractPrompt(text, schema);

	const response = await client.complete(prompt, { temperature: 0.1 });

	const parsed = parseExtractResponse<T>(response, logger);

	// Validate parsed JSON against the provided schema
	const validate = getValidator(schema);
	if (!validate(parsed)) {
		const errors = validate.errors
			?.map((e: ErrorObject) => `${e.instancePath} ${e.message}`)
			.join('; ');
		logger.warn({ schema, parsed, errors }, 'Extraction result does not match schema');
		throw new Error(`Extracted data does not match schema: ${errors}`);
	}

	return parsed;
}

/**
 * Parse the LLM's extraction response as JSON.
 *
 * Attempts to find and parse a JSON object in the response.
 */
export function parseExtractResponse<T>(response: string, logger: Logger): T {
	// Try to find JSON in the response (may be wrapped in markdown code blocks)
	const jsonMatch =
		response.match(/```(?:json)?\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*\})/);

	if (!jsonMatch) {
		logger.error({ response }, 'No JSON found in extraction response');
		throw new Error('LLM response did not contain valid JSON');
	}

	const jsonStr = jsonMatch[1]?.trim() ?? '';

	try {
		return JSON.parse(jsonStr) as T;
	} catch (err) {
		logger.error(
			{ response, jsonStr, error: err instanceof Error ? err.message : String(err) },
			'Failed to parse extraction response as JSON',
		);
		throw new Error(
			`Failed to parse LLM extraction response: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
