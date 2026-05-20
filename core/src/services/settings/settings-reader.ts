/**
 * SettingsReader — produces the chatbot settings catalog + trusted instruction block.
 *
 * catalog: per-user, per-turn label + value lines — goes inside <memory-context>.
 * trustedInstructions: plain text listing nlSafe keys — rendered OUTSIDE memory-context.
 *
 * Design:
 * - Groups visible settings by category (ordered by CATEGORY_ORDER).
 * - Reads live per-user overrides via appConfigResolver; falls back to registry defaults
 *   on missing AppConfigService or thrown getOverrides (degraded — logs warning).
 * - For system-scope defs (appId === 'system'), reads live values from SystemConfigWriter
 *   rather than AppConfigService.
 * - For per-user defs with systemConfigBackingKey: when no user override exists, displays
 *   the current system config value at the camelCase dotpath (effective-default resolver).
 * - sanitizeContextContent is called on the raw catalog before returning so hostile
 *   role-tag breakouts (</memory-context>, <system>, <user>, <assistant>) are neutralized.
 */
import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService, SystemConfig } from '../../types/config.js';
import { dotGet } from '../config/system-config-writer.js';
import type { SystemConfigWriter } from '../config/system-config-writer.js';
import { sanitizeContextContent } from '../prompt-assembly/memory-context.js';
import { CATEGORY_ORDER } from './categories.js';
import { formatDisplayValue } from './settings-formatter.js';
import type { SettingDef, SettingsCategory, SettingsRegistry } from './settings-registry.js';
import { qualifiedKey } from './settings-registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SettingsReaderDeps {
	registry: SettingsRegistry;
	/**
	 * Returns the AppConfigService for a given appId, or undefined when that app
	 * has no config service wired up. The reader gracefully degrades when undefined.
	 */
	appConfigResolver: (appId: string) => AppConfigService | undefined;
	logger?: AppLogger;
	/** Required for system-scope reads and effective-default resolution. */
	systemConfigWriter?: SystemConfigWriter;
	/** In-memory SystemConfig. Read-only from the reader's perspective. */
	systemConfig?: SystemConfig;
}

export interface CatalogOutput {
	/**
	 * Untrusted reference content (label + value lines).
	 * Goes inside <memory-context label="settings-catalog">.
	 * Empty string when no visible settings.
	 */
	catalog: string;
	/**
	 * Trusted action vocabulary listing nlSafe qualified keys with <config-set> syntax.
	 * Goes OUTSIDE the memory-context wrapper.
	 * Empty string when no nlSafe keys are available.
	 */
	trustedInstructions: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character length for the trusted instructions block.
 * Prevents unbounded context injection when many nlSafe keys are registered.
 */
const MAX_TRUSTED_INSTRUCTIONS_CHARS = 3_000;

// ---------------------------------------------------------------------------
// SettingsReader
// ---------------------------------------------------------------------------

export class SettingsReader {
	private readonly registry: SettingsRegistry;
	private readonly appConfigResolver: (appId: string) => AppConfigService | undefined;
	private readonly logger: AppLogger | undefined;
	private readonly systemConfigWriter: SystemConfigWriter | undefined;
	private readonly systemConfig: SystemConfig | undefined;

	constructor(deps: SettingsReaderDeps) {
		this.registry = deps.registry;
		this.appConfigResolver = deps.appConfigResolver;
		this.logger = deps.logger;
		this.systemConfigWriter = deps.systemConfigWriter;
		this.systemConfig = deps.systemConfig;
	}

	/**
	 * Build the catalog + trustedInstructions strings for a given user.
	 *
	 * @param userId  - The user whose overrides to read.
	 * @param isAdmin - When true, adminOnly settings are included.
	 */
	async buildCatalog({
		userId,
		isAdmin,
	}: { userId: string; isAdmin: boolean }): Promise<CatalogOutput> {
		const visible = this.registry.getForUser(isAdmin);
		if (visible.length === 0) {
			return { catalog: '', trustedInstructions: '' };
		}

		// Collect per-app overrides in a single pass (one getOverrides call per appId).
		const overridesByApp = await this.fetchAllOverrides(userId, visible);

		// Group visible defs by category in the canonical order.
		const byCategory = new Map<SettingsCategory, SettingDef[]>();
		for (const cat of CATEGORY_ORDER) {
			byCategory.set(cat, []);
		}
		for (const def of visible) {
			const bucket = byCategory.get(def.category);
			if (bucket) {
				bucket.push(def);
			} else {
				// Unknown category — append to 'system' as a safe fallback.
				byCategory.get('system')!.push(def);
			}
		}

		// Build raw catalog lines.
		const lines: string[] = ['## Your settings'];
		for (const cat of CATEGORY_ORDER) {
			const defs = byCategory.get(cat) ?? [];
			for (const def of defs) {
				const overrides = overridesByApp.get(def.appId) ?? {};
				const rawValue = this.resolveValue(def, overrides);
				lines.push(
					`- ${def.label} (${qualifiedKey(def.appId, def.key)}): ${formatDisplayValue(def, rawValue)}`,
				);
			}
		}

		const rawCatalog = lines.join('\n');

		// Sanitize once at source — neutralizes role-tag breakouts.
		// Use a very large maxChars so the sanitizer never truncates here;
		// the caller's buildMemoryContextBlock will apply the final size cap.
		const catalog = sanitizeContextContent(rawCatalog, Number.MAX_SAFE_INTEGER, '');

		// Build trusted instruction block (nlSafe keys only), capped at MAX_TRUSTED_INSTRUCTIONS_CHARS.
		const rawInstructions = this.buildTrustedInstructions();
		const trustedInstructions =
			rawInstructions.length > MAX_TRUSTED_INSTRUCTIONS_CHARS
				? `${rawInstructions.slice(0, MAX_TRUSTED_INSTRUCTIONS_CHARS)}\n... (instructions truncated)`
				: rawInstructions;

		return { catalog, trustedInstructions };
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Resolve the display value for a setting:
	 *   1. User override (highest priority).
	 *   2. For per-user defs with systemConfigBackingKey: the system config value.
	 *   3. The SettingDef default.
	 */
	private resolveValue(def: SettingDef, overrides: Record<string, unknown>): unknown {
		if (Object.prototype.hasOwnProperty.call(overrides, def.key)) {
			return overrides[def.key];
		}
		// Effective-default resolver: per-user def backed by a system config value.
		if (def.scope === 'per-user' && def.systemConfigBackingKey && this.systemConfig) {
			const systemValue = dotGet(
				this.systemConfig as unknown as Record<string, unknown>,
				def.systemConfigBackingKey,
			);
			if (systemValue !== undefined) return systemValue;
		}
		return def.default;
	}

	/**
	 * Fetches per-app overrides for all distinct appIds in the visible defs.
	 * For system-scope (appId === 'system'), reads live values via SystemConfigWriter.
	 * Errors from getOverrides are caught and logged (degraded, not thrown).
	 */
	private async fetchAllOverrides(
		userId: string,
		visible: SettingDef[],
	): Promise<Map<string, Record<string, unknown>>> {
		// Collect unique appIds.
		const appIds = [...new Set(visible.map((d) => d.appId))];

		const entries = await Promise.all(
			appIds.map(async (appId) => {
				// System-scope: read from SystemConfigWriter, not AppConfigService.
				if (appId === 'system') {
					return [appId, this.buildSystemOverrides(visible)] as const;
				}

				const cfg = this.appConfigResolver(appId);
				if (!cfg) {
					// No service for this app — use empty overrides (defaults will apply).
					return [appId, {}] as const;
				}
				try {
					const overrides = await cfg.getOverrides(userId);
					return [appId, overrides ?? {}] as const;
				} catch (err) {
					this.logger?.warn(
						'SettingsReader.buildCatalog: getOverrides failed for appId=%s userId=%s err=%s',
						appId,
						userId,
						err instanceof Error ? err.message : String(err),
					);
					return [appId, {}] as const;
				}
			}),
		);

		return new Map(entries);
	}

	/** Build a fake "overrides" record for system-scope defs by reading live SystemConfig values. */
	private buildSystemOverrides(visible: SettingDef[]): Record<string, unknown> {
		const writer = this.systemConfigWriter;
		const config = this.systemConfig;
		if (!writer || !config) return {};

		const result: Record<string, unknown> = {};
		for (const def of visible.filter((d) => d.appId === 'system')) {
			try {
				result[def.key] = writer.read(def.key, config);
			} catch {
				// Key not in allowlist or read error — fall back to def.default
			}
		}
		return result;
	}

	/**
	 * Builds the trusted instruction block listing nlSafe qualified keys.
	 * Returns empty string when there are no nlSafe keys.
	 */
	private buildTrustedInstructions(): string {
		const nlSafeKeys = [...this.registry.getNlSafeQualifiedKeys()].sort();
		if (nlSafeKeys.length === 0) return '';

		const keyLines = nlSafeKeys
			.map((qk) => {
				const def = this.registry.getByQualifiedKey(qk);
				const typeName = def ? def.type : 'string';
				return `  ${qk} (${typeName})`;
			})
			.join('\n');
		return [
			'You can change a per-user setting by including exactly one tag in your reply',
			'(the tag is removed before the user sees it):',
			'  <config-set key="<qualified-key>" value="<value>"/>',
			'Available keys:',
			keyLines,
			'Only emit a tag when the user explicitly asks to change a setting.',
			'You can also type `/settings` to view or change settings directly.',
		].join('\n');
	}
}
