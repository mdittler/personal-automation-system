import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService } from '../../types/config.js';
import type { ManifestUserConfig } from '../../types/manifest.js';
import { coerceUserConfigValue } from '../config/coerce-user-config.js';
import type { SettingsRegistry } from './settings-registry.js';
import { qualifiedKey } from './settings-registry.js';

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

export interface BatchAppResult {
  ok: boolean;
  reason?: string;
  /** Keys successfully persisted for this app. */
  written: string[];
}

export type BatchResult = {
  perApp: Map<string, BatchAppResult>;
  perField: Map<string, WriteResult>;
};

export type PostWriteHook = (ctx: {
  userId: string;
  appId: string;
  key: string;
  prevValue: unknown;
  newValue: unknown;
}) => Promise<void> | void;

export class SettingsWriter {
  private readonly hooks = new Map<string, PostWriteHook[]>();

  constructor(private readonly deps: SettingsWriterDeps) {}

  /**
   * Write a single setting. Validates, coerces, and persists immediately.
   * Matches the existing write() contract — use writeBatch() for the GUI
   * save flow (validation-atomic across all fields).
   */
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

    // Capture prev value for hook context before writing
    let prevValue: unknown = entry.default;
    try {
      const overrides = await cfg.getOverrides(req.userId);
      if (overrides !== null && Object.prototype.hasOwnProperty.call(overrides, req.key)) {
        prevValue = overrides[req.key];
      }
    } catch {
      // Non-fatal — hooks will see manifest default as prevValue
    }

    try {
      await cfg.updateOverrides(req.userId, { [req.key]: coerced.coerced });
      await this.runHooksForKey(qualifiedKey(req.appId, req.key), {
        userId: req.userId,
        appId: req.appId,
        key: req.key,
        prevValue,
        newValue: coerced.coerced,
      });
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

  /**
   * Pure validation — same policy gates and coercion as write(), but no I/O.
   * Synchronous. Safe to call in bulk dry-run passes.
   */
  validate(req: WriteRequest): WriteResult {
    const def = this.deps.registry.getByAppKey(req.appId, req.key);
    if (!def) {
      return { ok: false, reason: `not in registry: ${req.appId}.${req.key}` };
    }

    if (req.source === 'nl') {
      if (def.adminOnly || def.dangerous || def.hidden || !def.nlSafe || def.scope !== 'per-user') {
        return {
          ok: false,
          reason: `NL writes blocked for ${req.appId}.${req.key} (adminOnly/dangerous/hidden/non-nlSafe/non-per-user)`,
        };
      }
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

    return { ok: true, coerced: coerced.coerced };
  }

  /**
   * Register a hook to be called after a specific setting is successfully
   * persisted by writeBatch(). Hooks receive the pre-write and post-write values.
   * Multiple hooks per key are supported and fired in registration order.
   * A hook that throws is logged and swallowed — it does not fail the batch.
   */
  registerPostWriteHook(qKey: string, fn: PostWriteHook): void {
    const existing = this.hooks.get(qKey) ?? [];
    this.hooks.set(qKey, [...existing, fn]);
  }

  /**
   * Fire registered post-write hooks for a specific qualified key.
   * Used by the Reset endpoint to trigger side-effects (e.g. disableFlushAndCleanup)
   * without going through writeBatch. Errors are logged and swallowed.
   */
  async runHooksForKey(
    qKey: string,
    ctx: { userId: string; appId: string; key: string; prevValue: unknown; newValue: unknown },
  ): Promise<void> {
    const hooks = this.hooks.get(qKey) ?? [];
    for (const hook of hooks) {
      try {
        await hook(ctx);
      } catch (hookErr) {
        this.deps.logger.warn(
          'SettingsWriter: post-write hook threw for %s userId=%s: %s',
          qKey,
          ctx.userId,
          hookErr instanceof Error ? hookErr.message : String(hookErr),
        );
      }
    }
  }

  /**
   * Batch write — validation-atomic, per-app atomic on persist.
   *
   * Phase 1: validate ALL items (pure, no I/O). If any fails, returns
   *   immediately with perField populated and NO persistence.
   * Phase 2: group valid items by appId, persist each app's changes in
   *   one updateOverrides call (one file-lock per app). Cross-app atomicity
   *   is best-effort: if app B fails, app A's write stays. Caller should
   *   inspect perApp to detect partial failures.
   * Phase 3: fire registered post-write hooks (after successful persist,
   *   inside the same app loop iteration).
   */
  async writeBatch(items: WriteRequest[]): Promise<BatchResult> {
    const perField = new Map<string, WriteResult>();
    const perApp = new Map<string, BatchAppResult>();

    if (items.length === 0) return { perField, perApp };

    // Reject mixed-userId batches: all items must be for the same user.
    const firstUserId = items[0]!.userId;
    for (const item of items) {
      if (item.userId !== firstUserId) {
        throw new Error('writeBatch: mixed userIds in batch — all items must have the same userId');
      }
    }

    // Phase 1: validate all (pure — no I/O)
    const validItems: Array<{ req: WriteRequest; coerced: unknown }> = [];
    let anyInvalid = false;

    for (const req of items) {
      const result = this.validate(req);
      perField.set(qualifiedKey(req.appId, req.key), result);
      if (result.ok) {
        validItems.push({ req, coerced: result.coerced });
      } else {
        anyInvalid = true;
      }
    }

    if (anyInvalid) {
      // Validation-atomic: any failure means nothing persists.
      return { perField, perApp };
    }

    // Phase 2: group by appId
    const byApp = new Map<string, Array<{ req: WriteRequest; coerced: unknown }>>();
    for (const item of validItems) {
      const list = byApp.get(item.req.appId) ?? [];
      list.push(item);
      byApp.set(item.req.appId, list);
    }

    // Phase 3: persist per app
    for (const [appId, appItems] of byApp) {
      const cfg = this.deps.appConfigResolver(appId);
      if (!cfg) {
        const reason = `no AppConfigService for appId '${appId}'`;
        perApp.set(appId, { ok: false, reason, written: [] });
        for (const { req } of appItems) {
          perField.set(qualifiedKey(appId, req.key), { ok: false, reason });
        }
        continue;
      }

      const userId = appItems[0]!.req.userId;

      // Capture prev values for hooks before writing (best-effort; TOCTOU acceptable)
      let prevOverrides: Record<string, unknown> = {};
      try {
        prevOverrides = (await cfg.getOverrides(userId)) ?? {};
      } catch {
        // Non-fatal — hooks will see undefined prevValue
      }

      // Build merged partial (all keys for this app in one updateOverrides call)
      const mergedPartial: Record<string, unknown> = {};
      for (const { req, coerced } of appItems) {
        mergedPartial[req.key] = coerced;
      }

      try {
        await cfg.updateOverrides(userId, mergedPartial);

        // Fire post-write hooks (errors are logged, never propagated)
        const manifest = this.deps.manifestResolver(appId) ?? [];
        for (const { req, coerced } of appItems) {
          const qk = qualifiedKey(appId, req.key);
          const hooks = this.hooks.get(qk) ?? [];
          if (hooks.length === 0) continue;

          const manifestEntry = manifest.find((e) => e.key === req.key);
          const prevValue = Object.prototype.hasOwnProperty.call(prevOverrides, req.key)
            ? prevOverrides[req.key]
            : manifestEntry?.default;

          for (const hook of hooks) {
            try {
              await hook({ userId, appId, key: req.key, prevValue, newValue: coerced });
            } catch (hookErr) {
              this.deps.logger.warn(
                'SettingsWriter: post-write hook threw for %s userId=%s: %s',
                qk,
                userId,
                hookErr instanceof Error ? hookErr.message : String(hookErr),
              );
            }
          }
        }

        perApp.set(appId, { ok: true, written: appItems.map(({ req }) => req.key) });
      } catch (err) {
        this.deps.logger.warn(
          'SettingsWriter.writeBatch: persist failed for appId=%s userId=%s err=%s',
          appId,
          userId,
          err instanceof Error ? err.message : String(err),
        );
        const reason = 'persist failed';
        perApp.set(appId, { ok: false, reason, written: [] });
        for (const { req } of appItems) {
          perField.set(qualifiedKey(appId, req.key), { ok: false, reason });
        }
      }
    }

    return { perField, perApp };
  }
}
