import { describe, expect, it } from 'vitest';
import type { AppManifest } from '../../../types/manifest.js';
import { buildSettingsRegistry } from '../build-registry.js';

const baseAppMeta = { version: '1.0.0', author: 'x', description: 'y' };

function fakeFoodManifest(): AppManifest {
  return {
    app: { id: 'food', name: 'Food', ...baseAppMeta },
    user_config: [
      {
        key: 'seasonal_nudges',
        type: 'boolean',
        default: true,
        description: 'x',
        label: 'Seasonal nudges',
        help: 'Send weekly seasonal suggestions.',
        category: 'food',
        nlSafe: true,
        nlIntentRegex: '(turn|switch|enable|disable).*(seasonal|season).*(nudge|suggestion)',
      },
    ],
  } as unknown as AppManifest;
}

describe('buildSettingsRegistry', () => {
  it('includes chatbot virtual manifest and installed app manifests', () => {
    const reg = buildSettingsRegistry({ installedApps: [fakeFoodManifest()] });
    const ids = reg.getAll().map((d) => `${d.appId}.${d.key}`);
    expect(ids).toContain('chatbot.auto_detect_pas');
    expect(ids).toContain('food.seasonal_nudges');
  });

  it('does NOT double-register when an installed app declares appId="chatbot"', () => {
    const dup = {
      app: { id: 'chatbot', name: 'Chatbot', ...baseAppMeta },
      user_config: [
        { key: 'rogue', type: 'boolean', default: false, description: 'x', help: 'h' },
      ],
    } as unknown as AppManifest;
    const reg = buildSettingsRegistry({ installedApps: [dup] });
    const ids = reg.getAll().map((d) => `${d.appId}.${d.key}`);
    expect(ids).toContain('chatbot.log_to_notes'); // virtual
    expect(ids).not.toContain('chatbot.rogue');     // filtered
  });

  it('compiles nlIntentRegex strings to RegExp', () => {
    const reg = buildSettingsRegistry({ installedApps: [fakeFoodManifest()] });
    const def = reg.getByAppKey('food', 'seasonal_nudges')!;
    expect(def.nlIntentRegex).toBeInstanceOf(RegExp);
    expect(def.nlIntentRegex!.test('please turn off seasonal nudges')).toBe(true);
  });

  it('throws on duplicate qualified key across non-chatbot sources', () => {
    const a = {
      app: { id: 'food', name: 'Food', ...baseAppMeta },
      user_config: [{ key: 'x', type: 'boolean', default: false, description: 'd', help: 'h' }],
    } as unknown as AppManifest;
    const b = {
      app: { id: 'food', name: 'Food', ...baseAppMeta },
      user_config: [{ key: 'x', type: 'boolean', default: false, description: 'd', help: 'h' }],
    } as unknown as AppManifest;
    expect(() => buildSettingsRegistry({ installedApps: [a, b] })).toThrow(/duplicate.*food\.x/i);
  });

  it('FAILS FAST on invalid nlIntentRegex (no silent downgrade)', () => {
    const broken = {
      app: { id: 'broken', name: 'Broken', ...baseAppMeta },
      user_config: [
        {
          key: 'bad_regex',
          type: 'boolean',
          default: false,
          description: 'x',
          help: 'h',
          nlSafe: true,
          nlIntentRegex: '[invalid(regex',
        },
      ],
    } as unknown as AppManifest;
    expect(() => buildSettingsRegistry({ installedApps: [broken] })).toThrow(
      /invalid.*nlIntentRegex.*broken\.bad_regex/i,
    );
  });

  it('skips apps with no user_config', () => {
    const noConfig = {
      app: { id: 'echo', name: 'Echo', ...baseAppMeta },
    } as unknown as AppManifest;
    const reg = buildSettingsRegistry({ installedApps: [noConfig] });
    expect(reg.getAll().every((d) => d.appId !== 'echo')).toBe(true);
  });
});
