export type SettingsCategory =
  | 'personal'
  | 'food'
  | 'notes'
  | 'memory-sessions'
  | 'notifications'
  | 'system'
  | 'dangerous';

export interface SettingDef {
  key: string;
  appId: string;
  category: SettingsCategory;
  label: string;
  help: string;
  helpDetail?: string;
  type: 'boolean' | 'number' | 'string' | 'select';
  options?: string[];
  default: unknown;
  adminOnly: boolean;
  dangerous: boolean;
  dangerConfirmPrompt?: string;
  hidden: boolean;
  scope: 'per-user' | 'per-household' | 'system';
  nlSafe: boolean;
  nlIntentRegex?: RegExp;
}

export function qualifiedKey(appId: string, key: string): string {
  return `${appId}.${key}`;
}

export class SettingsRegistry {
  private readonly defs: SettingDef[] = [];
  private readonly byQualified = new Map<string, SettingDef>();

  register(def: SettingDef): void {
    if (!def.hidden && (!def.help || !def.help.trim())) {
      throw new Error(
        `SettingsRegistry: 'help' must be a non-empty string for key '${def.key}' (app '${def.appId}')`,
      );
    }
    if (def.nlSafe && !def.nlIntentRegex) {
      throw new Error(
        `SettingsRegistry: 'nlIntentRegex' is required when nlSafe=true (key '${def.appId}.${def.key}')`,
      );
    }
    if (def.type === 'select' && (!def.options || def.options.length === 0)) {
      throw new Error(
        `SettingsRegistry: 'options' is required and must be non-empty for select type (key '${def.appId}.${def.key}')`,
      );
    }
    if (def.dangerous && !def.dangerConfirmPrompt) {
      throw new Error(
        `SettingsRegistry: 'dangerConfirmPrompt' is required when dangerous=true (key '${def.appId}.${def.key}')`,
      );
    }
    if (def.dangerous && !def.adminOnly) {
      throw new Error(
        `SettingsRegistry: setting '${def.appId}.${def.key}' has dangerous=true but adminOnly=false — dangerous settings must also be adminOnly`,
      );
    }
    const qid = qualifiedKey(def.appId, def.key);
    if (this.byQualified.has(qid)) {
      throw new Error(`SettingsRegistry: duplicate key '${qid}'`);
    }
    const frozen = Object.freeze({ ...def });
    this.defs.push(frozen);
    this.byQualified.set(qid, frozen);
  }

  getAll(): SettingDef[] {
    return [...this.defs];
  }

  getByQualifiedKey(qid: string): SettingDef | undefined {
    return this.byQualified.get(qid);
  }

  getByAppKey(appId: string, key: string): SettingDef | undefined {
    return this.byQualified.get(qualifiedKey(appId, key));
  }

  getForUser(isAdmin: boolean): SettingDef[] {
    return this.defs.filter((d) => !d.hidden && (isAdmin || !d.adminOnly));
  }

  getForCategory(category: SettingsCategory, isAdmin: boolean): SettingDef[] {
    return this.getForUser(isAdmin).filter((d) => d.category === category);
  }

  getNlSafeQualifiedKeys(): Set<string> {
    return new Set(
      this.defs
        .filter(
          (d) =>
            d.nlSafe && !d.adminOnly && !d.dangerous && !d.hidden && d.scope === 'per-user',
        )
        .map((d) => qualifiedKey(d.appId, d.key)),
    );
  }
}
