/**
 * SystemConfigWriter — reads, writes, and resets system-scope settings.
 *
 * API uses unqualified YAML keys (e.g. 'chat.sessions.retention_days').
 * The 'system.' qualified prefix lives in the SettingsWriter layer.
 *
 * All writes go through mutatePasYaml so they serialise against the shared
 * file lock used by syncUsersToConfig (REQ-SETTINGS-024).
 *
 * The source flag passed to SettingsWriter is content policy, not auth.
 * Auth is enforced at the Fastify preHandler; this class enforces key
 * membership (closed allowlist via runtimePathTable).
 */
import type { SystemConfig } from '../../types/config.js';
import { mutatePasYaml } from './pas-yaml-mutator.js';

export interface SystemConfigWriterDeps {
	configPath: string;
	/** Maps unqualified YAML key → dot-path through SystemConfig. Closed allowlist. */
	runtimePathTable: Readonly<Record<string, string>>;
	/** Maps unqualified YAML key → the schema-level default value. */
	keyDefaults: Readonly<Record<string, unknown>>;
}

export class SystemConfigWriter {
	constructor(private readonly deps: SystemConfigWriterDeps) {}

	/**
	 * Read the current value for an unqualified key from the in-memory config.
	 * Throws if the key is not in runtimePathTable (closed allowlist).
	 */
	read(unqualifiedKey: string, config: SystemConfig): unknown {
		const runtimePath = this.resolveRuntimePath(unqualifiedKey);
		return dotGet(config as unknown as Record<string, unknown>, runtimePath);
	}

	/**
	 * Write a coerced value for an unqualified key.
	 *   1. Mutates in-memory config at the runtime path (REQ-SETTINGS-023).
	 *   2. Persists to pas.yaml at the snake_case YAML path (REQ-SETTINGS-022).
	 *
	 * If the YAML write fails the in-memory mutation is rolled back so both
	 * stores stay consistent.
	 */
	async write(unqualifiedKey: string, coerced: unknown, config: SystemConfig): Promise<void> {
		const runtimePath = this.resolveRuntimePath(unqualifiedKey);

		// Capture previous in-memory value for rollback on YAML failure.
		const prevValue = dotGet(config as unknown as Record<string, unknown>, runtimePath);

		// 1. Mutate in-memory first (optimistic).
		dotSet(config as unknown as Record<string, unknown>, runtimePath, coerced);

		// 2. Persist to YAML. Roll back in-memory on failure.
		try {
			await mutatePasYaml(this.deps.configPath, (parsed) => {
				dotSet(parsed, unqualifiedKey, coerced);
				return parsed;
			});
		} catch (err) {
			dotSet(config as unknown as Record<string, unknown>, runtimePath, prevValue);
			throw err;
		}
	}

	/**
	 * Remove the key from pas.yaml and mirror the schema default in-memory.
	 *
	 * Semantics (REQ-SETTINGS-036):
	 *   1. Delete the YAML key so Zod defaults apply on next load.
	 *   2. Set the in-memory field to the declared schema default.
	 *   3. Return the effective default so the route can render the row.
	 *
	 * The effective default is taken from `keyDefaults` (built from
	 * SYSTEM_SETTING_DEFS.default at construction time), which must equal
	 * what the config loader would produce when the key is absent from YAML.
	 */
	async resetToSchemaDefault(unqualifiedKey: string, config: SystemConfig): Promise<unknown> {
		this.resolveRuntimePath(unqualifiedKey); // validate allowlist membership

		if (!(unqualifiedKey in this.deps.keyDefaults)) {
			throw new Error(`SystemConfigWriter: no default registered for key '${unqualifiedKey}'.`);
		}

		const runtimePath = this.deps.runtimePathTable[unqualifiedKey]!;
		const effectiveDefault = this.deps.keyDefaults[unqualifiedKey];

		// Remove from YAML (throws on missing pas.yaml or FS error).
		await mutatePasYaml(this.deps.configPath, (parsed) => {
			dotDelete(parsed, unqualifiedKey);
			return parsed;
		});

		// Mirror default into in-memory config.
		dotSet(config as unknown as Record<string, unknown>, runtimePath, effectiveDefault);

		return effectiveDefault;
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private resolveRuntimePath(unqualifiedKey: string): string {
		const path = this.deps.runtimePathTable[unqualifiedKey];
		if (path === undefined) {
			throw new Error(
				`SystemConfigWriter: key '${unqualifiedKey}' is not in the runtime path table. Only keys declared in SYSTEM_KEY_RUNTIME_PATH are allowed (closed allowlist).`,
			);
		}
		return path;
	}
}

// ---------------------------------------------------------------------------
// Dot-path utilities (exported; also used by settings-reader.ts)
// ---------------------------------------------------------------------------

/**
 * Read a value from a nested object using a dot-notation path.
 * Returns undefined if any intermediate key is absent.
 */
export function dotGet(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split('.');
	let cur: unknown = obj;
	for (const part of parts) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/**
 * Set a value on a nested object using a dot-notation path, creating
 * intermediate objects as needed.
 */
export function dotSet(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.');
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		if (cur[part] === null || typeof cur[part] !== 'object') {
			cur[part] = {};
		}
		cur = cur[part] as Record<string, unknown>;
	}
	cur[parts[parts.length - 1]!] = value;
}

/**
 * Delete a leaf key from a nested object using a dot-notation path.
 * Silently does nothing if the key or any intermediate node is absent.
 */
export function dotDelete(obj: Record<string, unknown>, path: string): void {
	const parts = path.split('.');
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		if (cur[part] === null || typeof cur[part] !== 'object') return;
		cur = cur[part] as Record<string, unknown>;
	}
	delete cur[parts[parts.length - 1]!];
}
