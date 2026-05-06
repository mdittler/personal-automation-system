import { describe, expect, it, vi } from 'vitest';
import { SettingsRegistry, type SettingDef } from '../settings-registry.js';

function makeDef(overrides: Partial<SettingDef> = {}): SettingDef {
  return {
    key: 'log_to_notes',
    appId: 'chatbot',
    category: 'personal',
    label: 'Daily notes logging',
    help: 'Save every chat message to your daily notes file.',
    type: 'boolean',
    default: false,
    adminOnly: false,
    dangerous: false,
    hidden: false,
    scope: 'per-user',
    nlSafe: false,
    ...overrides,
  };
}

describe('SettingsRegistry', () => {
  describe('register + query', () => {
    it('registers and returns a SettingDef by qualified id', () => {
      const reg = new SettingsRegistry();
      const def = makeDef();
      reg.register(def);
      expect(reg.getAll()).toEqual([def]);
      expect(reg.getByQualifiedKey('chatbot.log_to_notes')).toEqual(def);
      expect(reg.getByAppKey('chatbot', 'log_to_notes')).toEqual(def);
    });

    it('qualifiedKey is the public stable id', () => {
      const reg = new SettingsRegistry();
      reg.register(makeDef({ appId: 'food', key: 'default_store' }));
      expect(reg.getByQualifiedKey('food.default_store')).toBeDefined();
      expect(reg.getByQualifiedKey('chatbot.default_store')).toBeUndefined();
    });

    it('allows the same key in different apps', () => {
      const reg = new SettingsRegistry();
      reg.register(makeDef({ appId: 'food', key: 'default_store' }));
      reg.register(makeDef({ appId: 'shopping', key: 'default_store' }));
      expect(reg.getAll().length).toBe(2);
    });
  });
});

describe('register validation (REQ-SETTINGS-006/008)', () => {
  it('throws when help is empty', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({ help: '' }))).toThrow(/help.*non-empty/i);
  });

  it('throws when help is whitespace only', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({ help: '   \n  ' }))).toThrow(/help.*non-empty/i);
  });

  it('throws when nlSafe=true and nlIntentRegex is absent', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({ nlSafe: true }))).toThrow(/nlIntentRegex.*required.*nlSafe/i);
  });

  it('throws when type=select and options is empty', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({ type: 'select', options: [] }))).toThrow(/options.*required.*select/i);
  });

  it('throws when type=select and options is absent', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({ type: 'select' }))).toThrow(/options.*required.*select/i);
  });

  it('throws when dangerous=true and dangerConfirmPrompt is absent', () => {
    const reg = new SettingsRegistry();
    expect(() =>
      reg.register(makeDef({ dangerous: true, adminOnly: true })),
    ).toThrow(/dangerConfirmPrompt.*required.*dangerous/i);
  });

  it('throws when dangerous=true but adminOnly=false', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({
      key: 'risky_setting',
      dangerous: true,
      dangerConfirmPrompt: 'Are you sure?',
      adminOnly: false,
    }))).toThrow(/dangerous.*must.*adminOnly/i);
  });

  it('accepts dangerous=true with adminOnly=true', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef({
      dangerous: true,
      dangerConfirmPrompt: 'confirm',
      adminOnly: true,
    }))).not.toThrow();
  });

  it('rejects duplicate qualified key', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({ appId: 'chatbot', key: 'log_to_notes' }));
    expect(() =>
      reg.register(makeDef({ appId: 'chatbot', key: 'log_to_notes' })),
    ).toThrow(/duplicate.*chatbot\.log_to_notes/i);
  });

  it('allows the same key in two different apps', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({ appId: 'food', key: 'default_store' }));
    expect(() =>
      reg.register(makeDef({ appId: 'shopping', key: 'default_store' })),
    ).not.toThrow();
  });

  it('accepts all-required-fields valid def', () => {
    const reg = new SettingsRegistry();
    expect(() => reg.register(makeDef())).not.toThrow();
  });

  it('accepts nlSafe=false without nlIntentRegex', () => {
    const reg = new SettingsRegistry();
    expect(() =>
      reg.register(makeDef({ nlSafe: false, nlIntentRegex: undefined })),
    ).not.toThrow();
  });
});

describe('getForUser admin/hidden filtering', () => {
  it('hides adminOnly from non-admins; admins see adminOnly', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({ key: 'public', adminOnly: false, hidden: false }));
    reg.register(makeDef({
      key: 'admin_only', adminOnly: true, dangerous: true,
      dangerConfirmPrompt: 'Type "I understand" to confirm',
    }));
    expect(reg.getForUser(false).map((d) => d.key)).toEqual(['public']);
    expect(reg.getForUser(true).map((d) => d.key).sort()).toEqual(['admin_only', 'public']);
  });

  it('hidden is unconditional — excluded from BOTH admin and non-admin views', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({ key: 'public', hidden: false }));
    reg.register(makeDef({ key: 'pseudo', hidden: true }));
    expect(reg.getForUser(false).map((d) => d.key)).toEqual(['public']);
    expect(reg.getForUser(true).map((d) => d.key)).toEqual(['public']);
  });
});

describe('register immutability (Fix 5)', () => {
  it('mutating the original SettingDef after register does not affect the stored def', () => {
    const reg = new SettingsRegistry();
    const def = makeDef({ nlSafe: false });
    reg.register(def);
    // Attempt mutation after registration
    (def as Record<string, unknown>).nlSafe = true;
    const stored = reg.getByQualifiedKey('chatbot.log_to_notes')!;
    expect(stored.nlSafe).toBe(false); // original value preserved
  });

  it('getAll returns a copy of the array — pushing to it does not affect the registry', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({ key: 'a_key', appId: 'chatbot' }));
    const copy = reg.getAll();
    // Mutate the returned array
    // @ts-expect-error — deliberately pushing a partial object to test array isolation
    copy.push({ key: 'injected' });
    expect(reg.getAll().length).toBe(1); // registry unaffected
  });
});

describe('getNlSafeQualifiedKeys (defense in depth)', () => {
  it('returns only nlSafe qualified keys', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({
      appId: 'chatbot', key: 'log_to_notes',
      nlSafe: true, nlIntentRegex: /\b(log|notes)\b/i,
    }));
    reg.register(makeDef({ appId: 'chatbot', key: 'auto_detect_pas', nlSafe: false }));
    expect(reg.getNlSafeQualifiedKeys()).toEqual(new Set(['chatbot.log_to_notes']));
  });

  it('excludes adminOnly even if nlSafe=true', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({
      appId: 'system', key: 'rogue', adminOnly: true,
      nlSafe: true, nlIntentRegex: /\brogue\b/i,
    }));
    expect(reg.getNlSafeQualifiedKeys().size).toBe(0);
  });

  it('excludes dangerous even if nlSafe=true', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({
      appId: 'system', key: 'auto_prune',
      adminOnly: true, dangerous: true, dangerConfirmPrompt: 'confirm',
      nlSafe: true, nlIntentRegex: /\bprune\b/i,
    }));
    expect(reg.getNlSafeQualifiedKeys().size).toBe(0);
  });

  it('excludes hidden even if nlSafe=true', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({
      appId: 'food', key: 'guest_profiles_info',
      hidden: true,
      nlSafe: true, nlIntentRegex: /\bguest\b/i,
    }));
    expect(reg.getNlSafeQualifiedKeys().size).toBe(0);
  });

  it('excludes non-per-user scope (household / system) even if nlSafe=true', () => {
    const reg = new SettingsRegistry();
    reg.register(makeDef({
      appId: 'food', key: 'shared_pref', scope: 'per-household',
      nlSafe: true, nlIntentRegex: /\bshared\b/i,
    }));
    reg.register(makeDef({
      appId: 'system', key: 'sys_pref', scope: 'system',
      nlSafe: true, nlIntentRegex: /\bsys\b/i,
    }));
    expect(reg.getNlSafeQualifiedKeys().size).toBe(0);
  });
});
