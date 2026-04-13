/**
 * Alert definition validator.
 *
 * Validates an AlertDefinition and returns an array of errors.
 * Empty array means the definition is valid.
 */

import cron from 'node-cron';
import type {
	AlertAction,
	AlertCondition,
	AlertDataSource,
	AlertDefinition,
	AlertValidationError,
	AudioActionConfig,
	DispatchMessageActionConfig,
	RunReportActionConfig,
	TelegramMessageActionConfig,
	WebhookActionConfig,
	WriteDataActionConfig,
} from '../../types/alert.js';
import {
	ALERT_ID_PATTERN,
	MAX_ACTIONS_PER_ALERT,
	MAX_ALERT_ID_LENGTH,
	MAX_ALERT_NAME_LENGTH,
	MAX_DATA_SOURCES,
} from '../../types/alert.js';
import { REPORT_ID_PATTERN } from '../../types/report.js';
import { SPACE_ID_PATTERN } from '../../types/spaces.js';
import { parseCooldown } from '../condition-evaluator/cooldown-tracker.js';
import type { UserManager } from '../user-manager/index.js';

const VALID_CONDITION_TYPES = ['deterministic', 'fuzzy'];
const VALID_ACTION_TYPES = [
	'telegram_message',
	'run_report',
	'webhook',
	'write_data',
	'audio',
	'dispatch_message',
];
const URL_PATTERN = /^https?:\/\//;
const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const EVENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,99}$/;

/**
 * Validate an alert definition. Returns an array of errors (empty = valid).
 */
export function validateAlert(
	def: AlertDefinition,
	userManager: UserManager,
): AlertValidationError[] {
	const errors: AlertValidationError[] = [];

	// ID validation
	if (!def.id) {
		errors.push({ field: 'id', message: 'Alert ID is required' });
	} else {
		if (!ALERT_ID_PATTERN.test(def.id)) {
			errors.push({
				field: 'id',
				message:
					'Alert ID must start with a letter and contain only lowercase letters, digits, and hyphens',
			});
		}
		if (def.id.length > MAX_ALERT_ID_LENGTH) {
			errors.push({
				field: 'id',
				message: `Alert ID must be at most ${MAX_ALERT_ID_LENGTH} characters`,
			});
		}
	}

	// Name validation
	if (!def.name || !def.name.trim()) {
		errors.push({ field: 'name', message: 'Alert name is required' });
	} else if (def.name.length > MAX_ALERT_NAME_LENGTH) {
		errors.push({
			field: 'name',
			message: `Alert name must be at most ${MAX_ALERT_NAME_LENGTH} characters`,
		});
	}

	// Trigger / schedule validation
	const isEventTrigger = def.trigger?.type === 'event';
	if (isEventTrigger) {
		const eventName = def.trigger?.event_name?.trim();
		if (!eventName) {
			errors.push({
				field: 'trigger.event_name',
				message: 'Event name is required for event triggers',
			});
		} else if (!EVENT_NAME_PATTERN.test(eventName)) {
			errors.push({
				field: 'trigger.event_name',
				message:
					'Event name must start with an alphanumeric character and contain only letters, digits, colons, dots, hyphens, and underscores (max 100 chars)',
			});
		}
		// schedule is optional for event triggers
	} else {
		// Scheduled trigger (or no trigger specified — backward compat)
		const schedule = def.trigger?.schedule ?? def.schedule;
		if (!schedule) {
			errors.push({ field: 'schedule', message: 'Schedule (cron expression) is required' });
		} else if (!cron.validate(schedule)) {
			errors.push({ field: 'schedule', message: 'Invalid cron expression' });
		}
	}

	// Delivery validation
	if (!Array.isArray(def.delivery) || def.delivery.length === 0) {
		errors.push({ field: 'delivery', message: 'At least one delivery target is required' });
	} else {
		for (const userId of def.delivery) {
			if (!userManager.isRegistered(userId)) {
				errors.push({
					field: 'delivery',
					message: `User ID "${userId}" is not a registered user`,
				});
			}
		}
	}

	// Cooldown validation
	if (!def.cooldown || !def.cooldown.trim()) {
		errors.push({ field: 'cooldown', message: 'Cooldown is required' });
	} else {
		const cooldownMs = parseCooldown(def.cooldown);
		if (cooldownMs === 0) {
			errors.push({
				field: 'cooldown',
				message:
					'Invalid cooldown format. Use "N minutes", "N hours", or "N days" (e.g., "1 hour", "24 hours")',
			});
		}
	}

	// Condition validation
	validateCondition(def.condition, errors);

	// Actions validation
	if (!Array.isArray(def.actions) || def.actions.length === 0) {
		errors.push({ field: 'actions', message: 'At least one action is required' });
	} else {
		if (def.actions.length > MAX_ACTIONS_PER_ALERT) {
			errors.push({
				field: 'actions',
				message: `Maximum ${MAX_ACTIONS_PER_ALERT} actions allowed`,
			});
		}
		for (let i = 0; i < def.actions.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: bounded by loop
			validateAction(def.actions[i]!, `actions[${i}]`, errors, userManager);
		}
	}

	return errors;
}

function validateCondition(
	condition: AlertCondition | undefined,
	errors: AlertValidationError[],
): void {
	if (!condition || typeof condition !== 'object') {
		errors.push({ field: 'condition', message: 'Condition is required' });
		return;
	}

	if (!VALID_CONDITION_TYPES.includes(condition.type)) {
		errors.push({
			field: 'condition.type',
			message: `Invalid condition type "${condition.type}". Must be one of: ${VALID_CONDITION_TYPES.join(', ')}`,
		});
	}

	if (!condition.expression || !condition.expression.trim()) {
		errors.push({
			field: 'condition.expression',
			message: 'Condition expression is required',
		});
	}

	if (!Array.isArray(condition.data_sources) || condition.data_sources.length === 0) {
		errors.push({
			field: 'condition.data_sources',
			message: 'At least one data source is required',
		});
	} else {
		if (condition.data_sources.length > MAX_DATA_SOURCES) {
			errors.push({
				field: 'condition.data_sources',
				message: `Maximum ${MAX_DATA_SOURCES} data sources allowed`,
			});
		}
		for (let i = 0; i < condition.data_sources.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: bounded by loop
			validateDataSource(condition.data_sources[i]!, `condition.data_sources[${i}]`, errors);
		}
	}
}

function validateDataSource(
	source: AlertDataSource,
	prefix: string,
	errors: AlertValidationError[],
): void {
	if (!source.app_id) {
		errors.push({ field: `${prefix}.app_id`, message: 'app_id is required' });
	} else if (!APP_ID_PATTERN.test(source.app_id)) {
		errors.push({
			field: `${prefix}.app_id`,
			message:
				'app_id must start with a letter and contain only lowercase letters, digits, and hyphens',
		});
	}

	// Validate space_id format when present
	if (source.space_id !== undefined) {
		if (!SPACE_ID_PATTERN.test(source.space_id)) {
			errors.push({
				field: `${prefix}.space_id`,
				message:
					'space_id must start with a letter and contain only lowercase letters, digits, and hyphens',
			});
		}
	}

	// user_id is required only when space_id is NOT set (use !== undefined to treat '' as "space scope with invalid value")
	if (source.space_id === undefined) {
		if (!source.user_id) {
			errors.push({
				field: `${prefix}.user_id`,
				message: 'user_id is required when space_id is not set',
			});
		} else if (!USER_ID_PATTERN.test(source.user_id)) {
			errors.push({
				field: `${prefix}.user_id`,
				message: 'user_id contains invalid characters',
			});
		}
	} else if (source.user_id && !USER_ID_PATTERN.test(source.user_id)) {
		// If user_id is provided alongside space_id, still validate format
		errors.push({
			field: `${prefix}.user_id`,
			message: 'user_id contains invalid characters',
		});
	}

	if (!source.path) {
		errors.push({ field: `${prefix}.path`, message: 'path is required' });
	} else {
		if (source.path.includes('..')) {
			errors.push({
				field: `${prefix}.path`,
				message: 'path must not contain ".."',
			});
		}
		if (source.path.startsWith('/') || source.path.startsWith('\\')) {
			errors.push({
				field: `${prefix}.path`,
				message: 'path must be relative (not start with / or \\)',
			});
		}
		if (source.path.includes('\\')) {
			errors.push({
				field: `${prefix}.path`,
				message: 'path must use forward slashes',
			});
		}
	}
}

function validateAction(
	action: AlertAction,
	prefix: string,
	errors: AlertValidationError[],
	userManager: UserManager,
): void {
	if (!VALID_ACTION_TYPES.includes(action.type)) {
		errors.push({
			field: `${prefix}.type`,
			message: `Invalid action type "${action.type}". Must be one of: ${VALID_ACTION_TYPES.join(', ')}`,
		});
		return;
	}

	if (!action.config || typeof action.config !== 'object') {
		errors.push({ field: `${prefix}.config`, message: 'Action config is required' });
		return;
	}

	switch (action.type) {
		case 'telegram_message':
			validateTelegramMessageConfig(action.config as TelegramMessageActionConfig, prefix, errors);
			break;
		case 'run_report':
			validateRunReportConfig(action.config as RunReportActionConfig, prefix, errors);
			break;
		case 'webhook':
			validateWebhookConfig(action.config as WebhookActionConfig, prefix, errors);
			break;
		case 'write_data':
			validateWriteDataConfig(action.config as WriteDataActionConfig, prefix, errors, userManager);
			break;
		case 'audio':
			validateAudioConfig(action.config as AudioActionConfig, prefix, errors);
			break;
		case 'dispatch_message':
			validateDispatchMessageConfig(
				action.config as DispatchMessageActionConfig,
				prefix,
				errors,
				userManager,
			);
			break;
	}
}

function validateTelegramMessageConfig(
	config: TelegramMessageActionConfig,
	prefix: string,
	errors: AlertValidationError[],
): void {
	if (!config.message || !config.message.trim()) {
		errors.push({
			field: `${prefix}.config.message`,
			message: 'Message text is required for telegram_message actions',
		});
	}
}

function validateRunReportConfig(
	config: RunReportActionConfig,
	prefix: string,
	errors: AlertValidationError[],
): void {
	if (!config.report_id) {
		errors.push({
			field: `${prefix}.config.report_id`,
			message: 'report_id is required for run_report actions',
		});
	} else if (!REPORT_ID_PATTERN.test(config.report_id)) {
		errors.push({
			field: `${prefix}.config.report_id`,
			message:
				'report_id must start with a letter and contain only lowercase letters, digits, and hyphens',
		});
	}
}

function validateWebhookConfig(
	config: WebhookActionConfig,
	prefix: string,
	errors: AlertValidationError[],
): void {
	if (!config.url || !config.url.trim()) {
		errors.push({
			field: `${prefix}.config.url`,
			message: 'URL is required for webhook actions',
		});
	} else if (!URL_PATTERN.test(config.url)) {
		errors.push({
			field: `${prefix}.config.url`,
			message: 'URL must start with http:// or https://',
		});
	}
}

function validateWriteDataConfig(
	config: WriteDataActionConfig,
	prefix: string,
	errors: AlertValidationError[],
	userManager: UserManager,
): void {
	if (!config.app_id) {
		errors.push({ field: `${prefix}.config.app_id`, message: 'app_id is required for write_data actions' });
	} else if (!APP_ID_PATTERN.test(config.app_id)) {
		errors.push({
			field: `${prefix}.config.app_id`,
			message: 'app_id must start with a letter and contain only lowercase letters, digits, and hyphens',
		});
	}

	if (!config.user_id) {
		errors.push({ field: `${prefix}.config.user_id`, message: 'user_id is required for write_data actions' });
	} else if (!USER_ID_PATTERN.test(config.user_id)) {
		errors.push({ field: `${prefix}.config.user_id`, message: 'user_id contains invalid characters' });
	} else if (!userManager.isRegistered(config.user_id)) {
		errors.push({ field: `${prefix}.config.user_id`, message: `User ID "${config.user_id}" is not a registered user` });
	}

	if (!config.path) {
		errors.push({ field: `${prefix}.config.path`, message: 'path is required for write_data actions' });
	} else {
		if (config.path.includes('..')) {
			errors.push({ field: `${prefix}.config.path`, message: 'path must not contain ".."' });
		}
		if (config.path.startsWith('/') || config.path.startsWith('\\')) {
			errors.push({ field: `${prefix}.config.path`, message: 'path must be relative (not start with / or \\)' });
		}
		if (config.path.includes('\\')) {
			errors.push({ field: `${prefix}.config.path`, message: 'path must use forward slashes' });
		}
	}

	if (!config.content && config.content !== '') {
		errors.push({ field: `${prefix}.config.content`, message: 'content is required for write_data actions' });
	}

	if (config.mode && config.mode !== 'write' && config.mode !== 'append') {
		errors.push({ field: `${prefix}.config.mode`, message: 'mode must be "write" or "append"' });
	}
}

function validateAudioConfig(
	config: AudioActionConfig,
	prefix: string,
	errors: AlertValidationError[],
): void {
	if (!config.message || !config.message.trim()) {
		errors.push({
			field: `${prefix}.config.message`,
			message: 'Message text is required for audio actions',
		});
	}
}

function validateDispatchMessageConfig(
	config: DispatchMessageActionConfig,
	prefix: string,
	errors: AlertValidationError[],
	userManager: UserManager,
): void {
	if (!config.text || !config.text.trim()) {
		errors.push({
			field: `${prefix}.config.text`,
			message: 'Text is required for dispatch_message actions',
		});
	}

	if (!config.user_id) {
		errors.push({
			field: `${prefix}.config.user_id`,
			message: 'user_id is required for dispatch_message actions',
		});
	} else if (!USER_ID_PATTERN.test(config.user_id)) {
		errors.push({ field: `${prefix}.config.user_id`, message: 'user_id contains invalid characters' });
	} else if (!userManager.isRegistered(config.user_id)) {
		errors.push({
			field: `${prefix}.config.user_id`,
			message: `User ID "${config.user_id}" is not a registered user`,
		});
	}
}
