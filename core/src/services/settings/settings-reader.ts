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
 * - sanitizeContextContent is called on the raw catalog before returning so hostile
 *   role-tag breakouts (</memory-context>, <system>, <user>, <assistant>) are neutralized.
 * - Does NOT advertise /settings or /gui/settings (those are future phases).
 */
import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import { sanitizeContextContent } from '../prompt-assembly/memory-context.js';
import { type SettingDef, SettingsRegistry, type SettingsCategory, qualifiedKey } from './settings-registry.js';

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
// Category display order
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: SettingsCategory[] = [
  'personal',
  'food',
  'notes',
  'memory-sessions',
  'notifications',
  'system',
  'dangerous',
];

// ---------------------------------------------------------------------------
// Value display helpers
// ---------------------------------------------------------------------------

function displayValue(def: SettingDef, raw: unknown): string {
  if (def.type === 'boolean') {
    if (raw === true) return 'ON';
    if (raw === false) return 'OFF';
    // Unexpected type — fall through to default
    return raw == null ? 'OFF' : String(raw);
  }

  if (def.type === 'string' || def.type === 'select') {
    if (raw == null || raw === '') return '(not set)';
    return String(raw);
  }

  if (def.type === 'number') {
    if (raw == null) return '(not set)';
    return String(raw);
  }

  // Fallback for unexpected types
  if (raw == null) return '(not set)';
  return String(raw);
}

// ---------------------------------------------------------------------------
// SettingsReader
// ---------------------------------------------------------------------------

export class SettingsReader {
  private readonly registry: SettingsRegistry;
  private readonly appConfigResolver: (appId: string) => AppConfigService | undefined;
  private readonly logger: AppLogger | undefined;

  constructor(deps: SettingsReaderDeps) {
    this.registry = deps.registry;
    this.appConfigResolver = deps.appConfigResolver;
    this.logger = deps.logger;
  }

  /**
   * Build the catalog + trustedInstructions strings for a given user.
   *
   * @param userId  - The user whose overrides to read.
   * @param isAdmin - When true, adminOnly settings are included.
   */
  async buildCatalog({ userId, isAdmin }: { userId: string; isAdmin: boolean }): Promise<CatalogOutput> {
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
        const rawValue = Object.prototype.hasOwnProperty.call(overrides, def.key)
          ? overrides[def.key]
          : def.default;
        lines.push(`- ${def.label}: ${displayValue(def, rawValue)}`);
      }
    }

    const rawCatalog = lines.join('\n');

    // Sanitize once at source — neutralizes role-tag breakouts.
    // Use a very large maxChars so the sanitizer never truncates here;
    // the caller's buildMemoryContextBlock will apply the final size cap.
    const catalog = sanitizeContextContent(rawCatalog, Number.MAX_SAFE_INTEGER, '');

    // Build trusted instruction block (nlSafe keys only).
    const trustedInstructions = this.buildTrustedInstructions();

    return { catalog, trustedInstructions };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetches per-app overrides for all distinct appIds in the visible defs.
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
    ].join('\n');
  }
}
