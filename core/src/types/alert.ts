/**
 * Conditional alert types.
 *
 * Alerts are infrastructure-level (not apps). They evaluate conditions
 * against data sources on a cron schedule and execute typed actions
 * when conditions are met.
 */

import type { ModelTier } from './llm.js';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

/** Supported alert action types. */
export type AlertActionType =
	| 'telegram_message'
	| 'run_report'
	| 'webhook'
	| 'write_data'
	| 'audio'
	| 'dispatch_message';

/** Config for 'telegram_message' action — sends a message to delivery users. */
export interface TelegramMessageActionConfig {
	/** Message text to send. Supports {data}, {summary}, {alert_name}, {date} template variables. */
	message: string;
	/** Optional LLM summary configuration. When enabled and message contains {summary}, generates a summary of the evaluated data. */
	llm_summary?: {
		enabled: boolean;
		/** Custom prompt for the LLM summary. Default: "Summarize this data briefly for a notification." */
		prompt?: string;
		/** LLM tier to use. Default: fast. */
		tier?: ModelTier;
		/** Maximum tokens for the summary. Default: 200. */
		max_tokens?: number;
	};
}

/** Config for 'run_report' action — executes a scheduled report by ID. */
export interface RunReportActionConfig {
	/** Report ID to execute (must exist in data/system/reports/). */
	report_id: string;
}

/** Config for 'webhook' action — POST JSON to a URL (e.g., for n8n workflows). */
export interface WebhookActionConfig {
	/** Target URL (must be http/https). */
	url: string;
	/** Whether to include evaluated data in the webhook payload. Default: false. */
	include_data?: boolean;
}

/** Config for 'write_data' action — write/append to a data file via DataStore. */
export interface WriteDataActionConfig {
	/** Target app's data directory. */
	app_id: string;
	/** Target user ID. */
	user_id: string;
	/** File path within user's app data. Supports {date}, {today} tokens. */
	path: string;
	/** Text content to write. Supports {data}, {summary}, {alert_name}, {date} template variables. */
	content: string;
	/** Write mode. Default: append. */
	mode: 'write' | 'append';
}

/** Config for 'audio' action — TTS announcement via AudioService + Chromecast. */
export interface AudioActionConfig {
	/** TTS text. Supports {data}, {summary}, {alert_name}, {date} template variables. */
	message: string;
	/** Chromecast device name. Uses default if omitted. */
	device?: string;
}

/** Config for 'dispatch_message' action — send a synthetic message through the router. */
export interface DispatchMessageActionConfig {
	/** Message text to route. Supports {data}, {summary}, {alert_name}, {date} template variables. */
	text: string;
	/** User ID context to dispatch as. */
	user_id: string;
}

/** Union of all action config types. */
export type AlertActionConfig =
	| TelegramMessageActionConfig
	| RunReportActionConfig
	| WebhookActionConfig
	| WriteDataActionConfig
	| AudioActionConfig
	| DispatchMessageActionConfig;

/** A single action within an alert definition. */
export interface AlertAction {
	type: AlertActionType;
	config: AlertActionConfig;
}

// ---------------------------------------------------------------------------
// Condition types
// ---------------------------------------------------------------------------

/** Supported condition evaluation types. */
export type AlertConditionType = 'deterministic' | 'fuzzy';

/** A data source to evaluate conditions against. */
export interface AlertDataSource {
	/** App ID whose data to read. */
	app_id: string;
	/** User ID whose data directory to read from. Required when space_id is not set. */
	user_id?: string;
	/** Relative file path within user's app data. Supports {today}, {yesterday} tokens. */
	path: string;
	/** Optional space ID — when set, reads from data/spaces/<space_id>/<app_id>/ instead of per-user. */
	space_id?: string;
}

/** Condition specification for an alert. */
export interface AlertCondition {
	/** Evaluation type. */
	type: AlertConditionType;
	/** Condition expression (e.g., "line count > 5", "contains \"warning\""). */
	expression: string;
	/** Data file sources to evaluate against. */
	data_sources: AlertDataSource[];
}

// ---------------------------------------------------------------------------
// Trigger types
// ---------------------------------------------------------------------------

/** Supported alert trigger types. */
export type AlertTriggerType = 'scheduled' | 'event';

/** Defines how an alert is triggered. */
export interface AlertTrigger {
	type: AlertTriggerType;
	/** Cron schedule (required when type='scheduled'). */
	schedule?: string;
	/** Event name on EventBus (required when type='event'). */
	event_name?: string;
}

// ---------------------------------------------------------------------------
// Alert definition
// ---------------------------------------------------------------------------

/** A complete alert definition, stored as YAML. */
export interface AlertDefinition {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	/** 5-field cron expression for evaluation schedule. Kept for backward compat; prefer trigger. */
	schedule: string;
	/** Condition to evaluate. */
	condition: AlertCondition;
	/** Actions to execute when condition is met. */
	actions: AlertAction[];
	/** Trigger configuration. If absent, defaults to { type: 'scheduled', schedule }. */
	trigger?: AlertTrigger;
	/** Telegram user IDs to deliver alerts to. */
	delivery: string[];
	/** Human-readable cooldown string (e.g., "1 hour", "24 hours"). */
	cooldown: string;
	/** Cooldown in milliseconds (computed from cooldown string on load). */
	cooldownMs?: number;
	/** ISO timestamp of last time the alert fired, or null if never. */
	lastFired?: string | null;
	/** ISO timestamp of creation/update. */
	updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/** Result of evaluating an alert. */
export interface AlertEvaluationResult {
	alertId: string;
	/** Whether the condition was met. */
	conditionMet: boolean;
	/** Whether actions were triggered (condition met AND not in cooldown). */
	actionTriggered: boolean;
	/** Number of actions successfully executed. */
	actionsExecuted: number;
	/** Error message if evaluation failed. */
	error?: string;
}

/** Validation error from alert definition validation. */
export interface AlertValidationError {
	field: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid alert ID pattern. */
export const ALERT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Maximum alert ID length. */
export const MAX_ALERT_ID_LENGTH = 50;

/** Maximum alert name length. */
export const MAX_ALERT_NAME_LENGTH = 100;

/** Maximum actions per alert. */
export const MAX_ACTIONS_PER_ALERT = 5;

/** Maximum total alerts. */
export const MAX_ALERTS = 50;

/** Maximum data sources per alert condition. */
export const MAX_DATA_SOURCES = 5;
