import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';
import { coerceUserConfigValue } from '../config/coerce-user-config.js';
import type { SettingsRegistry } from './settings-registry.js';

export interface SettingsWriterDeps {
  registry: SettingsRegistry;
  appConfigResolver: (appId: string) => AppConfigService | undefined;
  manifestResolver: (appId: string) => ManifestUserConfig[] | undefined;
  logger: AppLogger;
}

export type WriteSource = 'nl' | 'admin-confirmed';

export interface WriteRequest {
  userId: string;
  appId: string;
  key: string;
  rawValue: string;
  source: WriteSource;
}

export type WriteResult =
  | { ok: true; coerced: unknown }
  | { ok: false; reason: string };

export class SettingsWriter {
  constructor(private readonly deps: SettingsWriterDeps) {}

  async write(req: WriteRequest): Promise<WriteResult> {
    const def = this.deps.registry.getByAppKey(req.appId, req.key);
    if (!def) {
      return { ok: false, reason: `not in registry: ${req.appId}.${req.key}` };
    }

    // Defense in depth: enforce NL safety policy at the writer level.
    if (req.source === 'nl') {
      if (def.adminOnly || def.dangerous || def.hidden || !def.nlSafe || def.scope !== 'per-user') {
        return {
          ok: false,
          reason: `NL writes blocked for ${req.appId}.${req.key} (adminOnly/dangerous/hidden/non-nlSafe/non-per-user)`,
        };
      }
    }

    const cfg = this.deps.appConfigResolver(req.appId);
    if (!cfg) {
      return { ok: false, reason: `no AppConfigService for appId '${req.appId}'` };
    }

    const manifest = this.deps.manifestResolver(req.appId) ?? [];
    const entry = manifest.find((e) => e.key === req.key);
    if (!entry) {
      return { ok: false, reason: `manifest entry missing for ${req.appId}.${req.key}` };
    }

    const coerced = coerceUserConfigValue(entry, req.rawValue);
    if (!coerced.ok) {
      return { ok: false, reason: `coercion failed: ${coerced.reason}` };
    }

    try {
      await cfg.updateOverrides(req.userId, { [req.key]: coerced.coerced });
      return { ok: true, coerced: coerced.coerced };
    } catch (err) {
      this.deps.logger.warn(
        'SettingsWriter.write failed: %s.%s userId=%s err=%s',
        req.appId,
        req.key,
        req.userId,
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false, reason: 'persist failed' };
    }
  }
}
