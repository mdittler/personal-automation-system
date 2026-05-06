import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import { SettingsRegistry } from '../settings-registry.js';
import { SettingsWriter } from '../settings-writer.js';

function makeLogger(): AppLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeRegistry() {
  const reg = new SettingsRegistry();
  reg.register({
    key: 'log_to_notes', appId: 'chatbot', category: 'personal',
    label: 'Daily notes', help: 'h', type: 'boolean', default: false,
    adminOnly: false, dangerous: false, hidden: false, scope: 'per-user',
    nlSafe: true, nlIntentRegex: /\bdaily notes\b/i,
  });
  reg.register({
    key: 'default_store', appId: 'food', category: 'food',
    label: 'Default store', help: 'h', type: 'string', default: '',
    adminOnly: false, dangerous: false, hidden: false, scope: 'per-user',
    nlSafe: true, nlIntentRegex: /\bdefault store\b/i,
  });
  return reg;
}

function makeAppConfig() {
  return {
    updateOverrides: vi.fn().mockResolvedValue(undefined),
    getOverrides: vi.fn().mockResolvedValue({}),
    getAll: vi.fn(),
    setAll: vi.fn(),
    get: vi.fn(),
  };
}

describe('SettingsWriter (REQ-SETTINGS-007)', () => {
  it('routes a chatbot write to the chatbot AppConfigService', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: (id) => (id === 'chatbot' ? chatbotCfg : id === 'food' ? foodCfg : undefined),
      manifestResolver: (id) => (id === 'chatbot'
        ? [{ key: 'log_to_notes', type: 'boolean', default: false, description: 'd' }]
        : []),
      logger: makeLogger(),
    });
    const r = await writer.write({
      userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl',
    });
    expect(r.ok).toBe(true);
    expect(chatbotCfg.updateOverrides).toHaveBeenCalledWith('u1', { log_to_notes: true });
    expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
  });

  it('routes a food write to the food AppConfigService', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: (id) => (id === 'chatbot' ? chatbotCfg : id === 'food' ? foodCfg : undefined),
      manifestResolver: (id) => (id === 'food'
        ? [{ key: 'default_store', type: 'string', default: '', description: 'd' }]
        : []),
      logger: makeLogger(),
    });
    const r = await writer.write({
      userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'Walmart', source: 'nl',
    });
    expect(r.ok).toBe(true);
    expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', { default_store: 'Walmart' });
    expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
  });

  it('rejects when registry has no def for the key', async () => {
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: () => makeAppConfig(),
      manifestResolver: () => [],
      logger: makeLogger(),
    });
    const r = await writer.write({ userId: 'u1', appId: 'food', key: 'unknown', rawValue: 'x', source: 'nl' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/not in registry/i);
  });

  it('rejects when AppConfigService is not registered for an appId', async () => {
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: () => undefined,
      manifestResolver: () => [{ key: 'default_store', type: 'string', default: '', description: 'd' }],
      logger: makeLogger(),
    });
    const r = await writer.write({ userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'x', source: 'nl' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/no AppConfigService/i);
  });

  it('rejects when manifest entry is missing (coercion impossible)', async () => {
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: () => makeAppConfig(),
      manifestResolver: () => [],
      logger: makeLogger(),
    });
    const r = await writer.write({ userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'x', source: 'nl' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/manifest/i);
  });

  it('rejects when coercion fails (boolean given non-boolean string)', async () => {
    const writer = new SettingsWriter({
      registry: makeRegistry(),
      appConfigResolver: () => makeAppConfig(),
      manifestResolver: () => [{ key: 'log_to_notes', type: 'boolean', default: false, description: 'd' }],
      logger: makeLogger(),
    });
    const r = await writer.write({ userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'maybe', source: 'nl' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toMatch(/coerc/i);
  });

  describe('policy enforcement (defense in depth)', () => {
    it('source=nl rejects adminOnly keys even if caller forgot to gate', async () => {
      const reg = new SettingsRegistry();
      reg.register({
        key: 'rogue', appId: 'system', category: 'system',
        label: 'rogue', help: 'h', type: 'boolean', default: false,
        adminOnly: true, dangerous: false, hidden: false, scope: 'per-user',
        nlSafe: true, nlIntentRegex: /\brogue\b/i,
      });
      const cfg = makeAppConfig();
      const writer = new SettingsWriter({
        registry: reg,
        appConfigResolver: () => cfg,
        manifestResolver: () => [{ key: 'rogue', type: 'boolean', default: false, description: 'd' }],
        logger: makeLogger(),
      });
      const r = await writer.write({ userId: 'u1', appId: 'system', key: 'rogue', rawValue: 'true', source: 'nl' });
      expect(r.ok).toBe(false);
      expect((r as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
      expect(cfg.updateOverrides).not.toHaveBeenCalled();
    });

    it('source=nl rejects dangerous keys', async () => {
      const reg = new SettingsRegistry();
      reg.register({
        key: 'auto_prune', appId: 'system', category: 'dangerous',
        label: 'Auto prune', help: 'h', type: 'boolean', default: false,
        adminOnly: true, dangerous: true, dangerConfirmPrompt: 'confirm',
        hidden: false, scope: 'system',
        nlSafe: true, nlIntentRegex: /\bprune\b/i,
      });
      const cfg = makeAppConfig();
      const writer = new SettingsWriter({
        registry: reg, appConfigResolver: () => cfg,
        manifestResolver: () => [{ key: 'auto_prune', type: 'boolean', default: false, description: 'd' }],
        logger: makeLogger(),
      });
      const r = await writer.write({
        userId: 'u1', appId: 'system', key: 'auto_prune', rawValue: 'true', source: 'nl',
      });
      expect(r.ok).toBe(false);
      expect(cfg.updateOverrides).not.toHaveBeenCalled();
    });

    it('source=nl rejects hidden keys', async () => {
      const reg = new SettingsRegistry();
      reg.register({
        key: 'guests', appId: 'food', category: 'food',
        label: 'Guests', help: 'h', type: 'string', default: '',
        adminOnly: false, dangerous: false, hidden: true, scope: 'per-user',
        nlSafe: false,
      });
      const cfg = makeAppConfig();
      const writer = new SettingsWriter({
        registry: reg, appConfigResolver: () => cfg,
        manifestResolver: () => [{ key: 'guests', type: 'string', default: '', description: 'd' }],
        logger: makeLogger(),
      });
      const r = await writer.write({ userId: 'u1', appId: 'food', key: 'guests', rawValue: 'x', source: 'nl' });
      expect(r.ok).toBe(false);
    });

    it('source=admin-confirmed bypasses NL safety filters but still coerces', async () => {
      const reg = new SettingsRegistry();
      reg.register({
        key: 'rogue', appId: 'system', category: 'system',
        label: 'rogue', help: 'h', type: 'boolean', default: false,
        adminOnly: true, dangerous: false, hidden: false, scope: 'per-user',
        nlSafe: false,
      });
      const cfg = makeAppConfig();
      const writer = new SettingsWriter({
        registry: reg, appConfigResolver: () => cfg,
        manifestResolver: () => [{ key: 'rogue', type: 'boolean', default: false, description: 'd' }],
        logger: makeLogger(),
      });
      const r = await writer.write({
        userId: 'admin', appId: 'system', key: 'rogue', rawValue: 'true', source: 'admin-confirmed',
      });
      expect(r.ok).toBe(true);
      expect(cfg.updateOverrides).toHaveBeenCalledWith('admin', { rogue: true });
    });
  });
});
