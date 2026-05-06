import type { SettingsCategory } from './settings-registry.js';

/**
 * Canonical rendering order for settings categories — used by SettingsReader
 * and the /gui/settings page to group settings consistently.
 */
export const CATEGORY_ORDER: readonly SettingsCategory[] = [
	'personal',
	'food',
	'notes',
	'memory-sessions',
	'notifications',
	'system',
	'dangerous',
];

/**
 * Human-readable labels for each settings category.
 */
export const CATEGORY_LABELS: Record<SettingsCategory, string> = {
	personal: 'Personal',
	food: 'Food',
	notes: 'Notes',
	'memory-sessions': 'Memory & Sessions',
	notifications: 'Notifications',
	system: 'System',
	dangerous: 'Dangerous',
};
