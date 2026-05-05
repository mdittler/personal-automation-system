/**
 * Sidecar codec for ContextEntryKind.
 *
 * Each context directory may contain a `.kinds.yaml` file that maps
 * entry slugs to their ContextEntryKind. This file is managed
 * independently of the `.md` entry files so that adding/removing
 * entries does not require frontmatter on the Markdown files.
 *
 * Format example:
 *   food-preferences: user-preference
 *   morning-routine: communication-preference
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import { parse, stringify } from 'yaml';
import type { ContextEntryKind } from '../../types/context-store.js';
import { CONTEXT_ENTRY_KINDS } from '../../types/context-store.js';
import { withFileLock } from '../../utils/file-mutex.js';
import { atomicWrite } from '../../utils/file.js';
import { readYamlFileStrict } from '../../utils/yaml.js';

const KINDS_FILENAME = '.kinds.yaml';

function kindsSidecarPath(dir: string): string {
	return join(dir, KINDS_FILENAME);
}

function isValidKind(value: unknown): value is ContextEntryKind {
	return CONTEXT_ENTRY_KINDS.includes(value as ContextEntryKind);
}

/**
 * Load the kinds map from a `.kinds.yaml` sidecar file in the given directory.
 *
 * Fail-open:
 * - Missing file → empty map (no warning).
 * - Missing directory → empty map (no warning).
 * - Corrupt YAML → empty map + structured warning log.
 * - Invalid kind value → entry skipped + warning log.
 */
export async function loadKindsMap(
	dir: string,
	logger: Logger,
): Promise<Map<string, ContextEntryKind>> {
	const filePath = kindsSidecarPath(dir);
	const result = await readYamlFileStrict(filePath);

	// File not found (or directory doesn't exist) — silent fail-open
	if (result === null) {
		return new Map();
	}

	// YAML parse error — warn and fail-open
	if ('error' in result) {
		logger.warn({ filePath, error: result.error }, 'kinds-sidecar: corrupt YAML, ignoring');
		return new Map();
	}

	const raw = result.data;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		logger.warn({ filePath }, 'kinds-sidecar: unexpected YAML structure, ignoring');
		return new Map();
	}

	const map = new Map<string, ContextEntryKind>();
	for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidKind(value)) {
			logger.warn({ filePath, slug, value }, 'kinds-sidecar: invalid kind value, skipping entry');
			continue;
		}
		map.set(slug, value);
	}

	return map;
}

/**
 * Persist a slug→kind mapping to the `.kinds.yaml` sidecar in the given directory.
 *
 * Uses `withFileLock` to serialise concurrent writes for the same directory.
 * The write is atomic (temp + rename via `atomicWrite`).
 */
export async function setKind(
	dir: string,
	slug: string,
	kind: ContextEntryKind,
	logger: Logger,
): Promise<void> {
	const filePath = kindsSidecarPath(dir);

	await withFileLock(filePath, async () => {
		// Load current map (fail-open — corrupt or missing → start fresh)
		const existing = await loadKindsMap(dir, logger);
		existing.set(slug, kind);

		// Convert back to a plain object for serialisation
		const obj: Record<string, string> = {};
		for (const [k, v] of existing) {
			obj[k] = v;
		}

		await atomicWrite(filePath, stringify(obj));
	});
}

// Re-export parse for internal use by callers that need raw YAML round-trips
export { parse, stringify };
