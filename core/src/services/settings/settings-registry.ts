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
  min?: number;
  max?: number;
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
    // Validation deferred to Task 1.2 — just store for now.
    const qid = qualifiedKey(def.appId, def.key);
    this.defs.push(def);
    this.byQualified.set(qid, def);
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
