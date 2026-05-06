import { describe, expect, it } from 'vitest';
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
