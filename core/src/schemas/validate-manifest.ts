/**
 * Manifest validation using Ajv.
 *
 * Validates an unknown object against the app manifest JSON Schema.
 * Returns either a typed AppManifest on success or human-readable
 * error strings on failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv/dist/2020.js';
import type { AppManifest } from '../types/manifest.js';

/** Successful validation result. */
export interface ValidationSuccess {
	valid: true;
	manifest: AppManifest;
}

/** Failed validation result with human-readable errors. */
export interface ValidationFailure {
	valid: false;
	errors: string[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// Load the JSON Schema from disk
const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, 'app-manifest.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as object;

// Create and configure the Ajv 2020-12 instance once
const ajv = new Ajv2020.default({
	allErrors: true,
	strict: true,
	strictSchema: true,
	verbose: true,
});

// ajv-formats CJS/ESM interop: the default export may be nested
const applyFormats = (typeof addFormats === 'function' ? addFormats : addFormats.default) as (
	ajv: InstanceType<typeof Ajv2020.default>,
) => void;
applyFormats(ajv);

const validateFn = ajv.compile(schema);

/**
 * Format an Ajv error into a human-readable string.
 */
function formatError(err: ErrorObject): string {
	const path = err.instancePath || '/';
	const message = err.message ?? 'unknown error';

	if (err.keyword === 'required') {
		const missing = (err.params as { missingProperty?: string }).missingProperty;
		return `${path}: missing required property '${missing}'`;
	}
	if (err.keyword === 'pattern') {
		return `${path}: ${message} (got: ${JSON.stringify(err.data)})`;
	}
	if (err.keyword === 'enum') {
		const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues;
		return `${path}: ${message}. Allowed: ${JSON.stringify(allowed)}`;
	}
	if (err.keyword === 'const') {
		return `${path}: ${message} (${JSON.stringify(err.params)})`;
	}
	if (err.keyword === 'additionalProperties') {
		const extra = (err.params as { additionalProperty?: string }).additionalProperty;
		return `${path}: unexpected property '${extra}'`;
	}

	return `${path}: ${message}`;
}

/**
 * Validate an unknown value against the app manifest schema.
 *
 * @param data - The parsed manifest data (from YAML or JSON).
 * @returns A ValidationSuccess with the typed manifest, or a ValidationFailure with errors.
 */
export function validateManifest(data: unknown): ValidationResult {
	const valid = validateFn(data);

	if (valid) {
		return {
			valid: true,
			manifest: data as AppManifest,
		};
	}

	const errors = (validateFn.errors ?? []).map(formatError);

	return {
		valid: false,
		errors,
	};
}
