import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import { SettingsRegistry } from '../settings-registry.js';
import {
  SettingsWriter,
  type PostWriteHook,
  type WriteRequest,
} from '../settings-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeAppConfig(initialOverrides: Record<string, unknown> = {}) {
  return {
    updateOverrides: vi.fn().mockResolvedValue(undefined),
    getOverrides: vi.fn().mockResolvedValue({ ...initialOverrides }),
    getAll: vi.fn(),
    setAll: vi.fn(),
    get: vi.fn(),
  };
}

function makeRegistry() {
  const reg = new SettingsRegistry();
  reg.register({
    key: 'log_to_notes',
    appId: 'chatbot',
    category: 'personal',
    label: 'Daily notes',
    help: 'Log conversation to notes',
    type: 'boolean',
    default: false,
    adminOnly: false,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: true,
    nlIntentRegex: /\bdaily notes\b/i,
  });
  reg.register({
    key: 'flush_memory_on_idle_reset',
    appId: 'chatbot',
    category: 'memory-sessions',
    label: 'Flush memory on idle reset',
    help: 'Save a session summary when idle reset fires',
    type: 'boolean',
    default: false,
    adminOnly: false,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: true,
    nlIntentRegex: /\bflush memory\b/i,
  });
  reg.register({
    key: 'default_store',
    appId: 'food',
    category: 'food',
    label: 'Default store',
    help: 'Your preferred grocery store',
    type: 'string',
    default: '',
    adminOnly: false,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: true,
    nlIntentRegex: /\bdefault store\b/i,
  });
  reg.register({
    key: 'hidden_field',
    appId: 'chatbot',
    category: 'personal',
    label: 'Hidden',
    help: 'h',
    type: 'string',
    default: '',
    adminOnly: false,
    dangerous: false,
    hidden: true,
    scope: 'per-user',
    nlSafe: false,
  });
  reg.register({
    key: 'admin_key',
    appId: 'chatbot',
    category: 'system',
    label: 'Admin key',
    help: 'Admin only setting',
    type: 'boolean',
    default: false,
    adminOnly: true,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: false,
  });
  reg.register({
    key: 'not_nl_safe',
    appId: 'food',
    category: 'food',
    label: 'Internal key',
    help: 'Not nlSafe',
    type: 'string',
    default: '',
    adminOnly: false,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: false,
  });
  return reg;
}

const CHATBOT_MANIFEST = [
  { key: 'log_to_notes', type: 'boolean' as const, default: false, description: 'd' },
  { key: 'flush_memory_on_idle_reset', type: 'boolean' as const, default: false, description: 'd' },
  { key: 'hidden_field', type: 'string' as const, default: '', description: 'd' },
  { key: 'admin_key', type: 'boolean' as const, default: false, description: 'd' },
];
const FOOD_MANIFEST = [
  { key: 'default_store', type: 'string' as const, default: '', description: 'd' },
  { key: 'not_nl_safe', type: 'string' as const, default: '', description: 'd' },
];

function makeManifestResolver() {
  return (appId: string) => {
    if (appId === 'chatbot') return CHATBOT_MANIFEST;
    if (appId === 'food') return FOOD_MANIFEST;
    return undefined;
  };
}

function makeWriter(
  chatbotCfg = makeAppConfig(),
  foodCfg = makeAppConfig(),
  logger = makeLogger(),
) {
  const registry = makeRegistry();
  return {
    writer: new SettingsWriter({
      registry,
      appConfigResolver: (id: string) =>
        id === 'chatbot' ? chatbotCfg : id === 'food' ? foodCfg : undefined,
      manifestResolver: makeManifestResolver(),
      logger,
    }),
    chatbotCfg,
    foodCfg,
    logger,
    registry,
  };
}

// ---------------------------------------------------------------------------
// SettingsWriter.validate() — Slice 0
// ---------------------------------------------------------------------------

describe('SettingsWriter.validate()', () => {
  it('returns ok:true with coerced value for a valid nlSafe per-user key', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl',
    });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; coerced: unknown }).coerced).toBe(true);
  });

  it('returns ok:false for an unknown key', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'does_not_exist', rawValue: 'x', source: 'nl',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/not in registry/i);
  });

  it('blocks NL writes for hidden keys', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'hidden_field', rawValue: 'x', source: 'nl',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
  });

  it('blocks NL writes for adminOnly keys', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'admin_key', rawValue: 'true', source: 'nl',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
  });

  it('blocks NL writes for non-nlSafe keys', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'food', key: 'not_nl_safe', rawValue: 'x', source: 'nl',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/NL writes blocked/);
  });

  it('allows admin-confirmed writes for adminOnly keys (bypasses NL gate)', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'admin', appId: 'chatbot', key: 'admin_key', rawValue: 'true', source: 'admin-confirmed',
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with coercion reason when value cannot be coerced', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'maybe', source: 'nl',
    });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toMatch(/coerc/i);
  });

  it('is pure — never calls updateOverrides', () => {
    const chatbotCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg);
    writer.validate({
      userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl',
    });
    expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
  });

  it('coerces string type to trimmed value', () => {
    const { writer } = makeWriter();
    const result = writer.validate({
      userId: 'u1', appId: 'food', key: 'default_store', rawValue: '  Costco  ', source: 'nl',
    });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; coerced: unknown }).coerced).toBe('Costco');
  });
});

// ---------------------------------------------------------------------------
// SettingsWriter.writeBatch() — Slice 0
// ---------------------------------------------------------------------------

describe('SettingsWriter.writeBatch()', () => {
  it('returns empty maps and makes no I/O for an empty batch', async () => {
    const chatbotCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg);
    const result = await writer.writeBatch([]);
    expect(result.perField.size).toBe(0);
    expect(result.perApp.size).toBe(0);
    expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
  });

  it('persists 2 fields in same app with a single updateOverrides call', async () => {
    const chatbotCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg);
    const items: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      { userId: 'u1', appId: 'chatbot', key: 'flush_memory_on_idle_reset', rawValue: 'false', source: 'nl' },
    ];
    const result = await writer.writeBatch(items);
    expect(chatbotCfg.updateOverrides).toHaveBeenCalledTimes(1);
    expect(chatbotCfg.updateOverrides).toHaveBeenCalledWith('u1', {
      log_to_notes: true,
      flush_memory_on_idle_reset: false,
    });
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(true);
    expect(result.perField.get('chatbot.flush_memory_on_idle_reset')?.ok).toBe(true);
    expect(result.perApp.get('chatbot')?.ok).toBe(true);
    expect(result.perApp.get('chatbot')?.written).toEqual(
      expect.arrayContaining(['log_to_notes', 'flush_memory_on_idle_reset']),
    );
  });

  it('persists 1 field in each of 2 apps with separate updateOverrides calls', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg, foodCfg);
    const items: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      { userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'Costco', source: 'nl' },
    ];
    const result = await writer.writeBatch(items);
    expect(chatbotCfg.updateOverrides).toHaveBeenCalledTimes(1);
    expect(foodCfg.updateOverrides).toHaveBeenCalledTimes(1);
    expect(result.perApp.get('chatbot')?.ok).toBe(true);
    expect(result.perApp.get('food')?.ok).toBe(true);
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(true);
    expect(result.perField.get('food.default_store')?.ok).toBe(true);
  });

  it('is validation-atomic: any invalid item blocks all persists', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg, foodCfg);
    const items: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      { userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'bad_boolean', source: 'nl' },
    ];
    // food.default_store is type string, so 'bad_boolean' is actually valid — use the boolean field with an invalid value
    const items2: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'not-a-bool', source: 'nl' },
      { userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'Costco', source: 'nl' },
    ];
    const result = await writer.writeBatch(items2);
    expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
    expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(false);
    expect(result.perApp.size).toBe(0);
  });

  it('records all perField errors when multiple items fail validation', async () => {
    const { writer } = makeWriter();
    const items: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'not-a-bool', source: 'nl' },
      { userId: 'u1', appId: 'chatbot', key: 'flush_memory_on_idle_reset', rawValue: 'also-bad', source: 'nl' },
    ];
    const result = await writer.writeBatch(items);
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(false);
    expect(result.perField.get('chatbot.flush_memory_on_idle_reset')?.ok).toBe(false);
  });

  it('per-app failure: failed app is ok:false, successful app stays ok:true', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    foodCfg.updateOverrides.mockRejectedValueOnce(new Error('disk full'));
    const { writer } = makeWriter(chatbotCfg, foodCfg);
    const items: WriteRequest[] = [
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      { userId: 'u1', appId: 'food', key: 'default_store', rawValue: 'Costco', source: 'nl' },
    ];
    const result = await writer.writeBatch(items);
    expect(result.perApp.get('chatbot')?.ok).toBe(true);
    expect(result.perApp.get('food')?.ok).toBe(false);
    expect(result.perField.get('food.default_store')?.ok).toBe(false);
    // chatbot field was already recorded as ok before food failed
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(true);
  });

  it('fires post-write hook with correct ctx for each persisted field', async () => {
    const chatbotCfg = makeAppConfig({ log_to_notes: false });
    const { writer } = makeWriter(chatbotCfg);
    const hook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('chatbot.log_to_notes', hook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith({
      userId: 'u1',
      appId: 'chatbot',
      key: 'log_to_notes',
      prevValue: false,
      newValue: true,
    });
  });

  it('hook that throws is logged and swallowed — persist still ok', async () => {
    const chatbotCfg = makeAppConfig();
    const logger = makeLogger();
    const { writer } = makeWriter(chatbotCfg, makeAppConfig(), logger);
    writer.registerPostWriteHook('chatbot.log_to_notes', async () => {
      throw new Error('hook exploded');
    });
    const result = await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(result.perApp.get('chatbot')?.ok).toBe(true);
    expect(result.perField.get('chatbot.log_to_notes')?.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('post-write hook threw'),
      'chatbot.log_to_notes',
      'u1',
      'hook exploded',
    );
  });

  it('prevValue reflects existing override when one is set', async () => {
    const chatbotCfg = makeAppConfig({ log_to_notes: true });
    const { writer } = makeWriter(chatbotCfg);
    const hook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('chatbot.log_to_notes', hook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'false', source: 'nl' },
    ]);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ prevValue: true, newValue: false }));
  });

  it('prevValue falls back to manifest default when no override exists for the key', async () => {
    const chatbotCfg = makeAppConfig({});
    const { writer } = makeWriter(chatbotCfg);
    const hook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('chatbot.log_to_notes', hook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    // No existing override — prevValue should be manifest default (false)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ prevValue: false, newValue: true }));
  });

  it('fires no hooks when no hooks are registered for a key', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg, foodCfg);
    // Register a hook for a different key to confirm it does not fire
    const hook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('food.default_store', hook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(hook).not.toHaveBeenCalled();
  });

  it('perApp written list contains all persisted keys', async () => {
    const chatbotCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      { userId: 'u1', appId: 'chatbot', key: 'flush_memory_on_idle_reset', rawValue: 'false', source: 'nl' },
    ]);
    const appResult = chatbotCfg.updateOverrides.mock.calls[0];
    expect(appResult[1]).toMatchObject({ log_to_notes: true, flush_memory_on_idle_reset: false });
  });

  it('both concurrent writeBatch calls resolve without error (mocked I/O)', async () => {
    const chatbotCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg);
    const [r1, r2] = await Promise.all([
      writer.writeBatch([
        { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
      ]),
      writer.writeBatch([
        { userId: 'u1', appId: 'chatbot', key: 'flush_memory_on_idle_reset', rawValue: 'true', source: 'nl' },
      ]),
    ]);
    expect(r1.perApp.get('chatbot')?.ok).toBe(true);
    expect(r2.perApp.get('chatbot')?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SettingsWriter.registerPostWriteHook() — Slice 0
// ---------------------------------------------------------------------------

describe('SettingsWriter.registerPostWriteHook()', () => {
  it('supports multiple hooks per key and fires them in registration order', async () => {
    const { writer } = makeWriter();
    const order: number[] = [];
    writer.registerPostWriteHook('chatbot.log_to_notes', () => { order.push(1); });
    writer.registerPostWriteHook('chatbot.log_to_notes', () => { order.push(2); });
    writer.registerPostWriteHook('chatbot.log_to_notes', () => { order.push(3); });
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('hooks for different keys are independent — only matching key fires', async () => {
    const chatbotCfg = makeAppConfig();
    const foodCfg = makeAppConfig();
    const { writer } = makeWriter(chatbotCfg, foodCfg);
    const chatbotHook = vi.fn() as PostWriteHook;
    const foodHook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('chatbot.log_to_notes', chatbotHook);
    writer.registerPostWriteHook('food.default_store', foodHook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(chatbotHook).toHaveBeenCalledTimes(1);
    expect(foodHook).not.toHaveBeenCalled();
  });

  it('remaining hooks still fire after one hook throws', async () => {
    const { writer } = makeWriter(makeAppConfig(), makeAppConfig(), makeLogger());
    const afterHook = vi.fn() as PostWriteHook;
    writer.registerPostWriteHook('chatbot.log_to_notes', async () => { throw new Error('fail'); });
    writer.registerPostWriteHook('chatbot.log_to_notes', afterHook);
    await writer.writeBatch([
      { userId: 'u1', appId: 'chatbot', key: 'log_to_notes', rawValue: 'true', source: 'nl' },
    ]);
    expect(afterHook).toHaveBeenCalledTimes(1);
  });
});
