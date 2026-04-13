/**
 * Report system types.
 *
 * Defines the types for the scheduled reports system. Reports are
 * infrastructure-level (not apps), configured via GUI, stored as YAML
 * in data/system/reports/, and delivered via Telegram on cron schedules.
 */

import type { ModelTier } from './llm.js';

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

/** Available data source types for report sections. */
export type SectionType = 'changes' | 'app-data' | 'context' | 'custom';

/** Config for 'changes' section — aggregates from the change log. */
export interface ChangesSectionConfig {
	/** Hours to look back (default: 24). */
	lookback_hours?: number;
	/** Filter to specific app IDs (empty = all apps). */
	app_filter?: string[];
}

/** Config for 'app-data' section — reads a specific app data file. */
export interface AppDataSectionConfig {
	/** App ID whose data to read. */
	app_id: string;
	/** User ID whose data directory to read from. Required when space_id is not set. */
	user_id?: string;
	/** Relative file path within user's app data. Supports {today}, {yesterday} tokens. */
	path: string;
	/** Optional space ID — when set, reads from data/spaces/<space_id>/<app_id>/ instead of per-user. */
	space_id?: string;
}

/** Config for 'context' section — queries context store by prefix. */
export interface ContextSectionConfig {
	/** Context store key prefix to search for. */
	key_prefix: string;
}

/** Config for 'custom' section — freeform text content. */
export interface CustomSectionConfig {
	/** Freeform markdown content to include. */
	text: string;
}

/** Union of all section config types. */
export type SectionConfig =
	| ChangesSectionConfig
	| AppDataSectionConfig
	| ContextSectionConfig
	| CustomSectionConfig;

// ---------------------------------------------------------------------------
// Report section and definition
// ---------------------------------------------------------------------------

/** A single section within a report definition. */
export interface ReportSection {
	type: SectionType;
	label: string;
	config: SectionConfig;
}

/** LLM configuration for report summarization. */
export interface ReportLLMConfig {
	/** Whether to use LLM to summarize gathered data. */
	enabled: boolean;
	/** Custom instructions for the LLM summarizer. */
	prompt?: string;
	/** Model tier to use (default: 'standard'). */
	tier?: ModelTier;
	/** Max output tokens (default: 500, max: 2000). */
	max_tokens?: number;
}

/** A complete report definition, stored as YAML. */
export interface ReportDefinition {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	/** 5-field cron expression. */
	schedule: string;
	/** Telegram user IDs to deliver the report to. */
	delivery: string[];
	/** Ordered list of data sections to include. */
	sections: ReportSection[];
	/** LLM summarization config. */
	llm: ReportLLMConfig;
	/** ISO timestamp of last creation/update. */
	updatedAt?: string;
	/**
	 * Transient runtime field — never persisted to disk.
	 * Set when the definition loaded from disk fails validation.
	 * Reports with errors are shown in the GUI but not scheduled or executed.
	 */
	_validationErrors?: ReportValidationError[];
}

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/** Result of running a report. */
export interface ReportRunResult {
	reportId: string;
	/** Formatted markdown output. */
	markdown: string;
	/** Whether LLM summarization was used. */
	summarized: boolean;
	/** Which LLM tier was used, if any. */
	llmTier?: ModelTier;
	/** ISO timestamp of the run. */
	runAt: string;
}

/** Validation error from report definition validation. */
export interface ReportValidationError {
	field: string;
	message: string;
}

/** Collected data from a single section. */
export interface CollectedSection {
	label: string;
	/** Gathered raw data as markdown. */
	content: string;
	/** Whether the section had no data. */
	isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid report ID pattern. */
export const REPORT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Maximum report ID length. */
export const MAX_REPORT_ID_LENGTH = 50;

/** Maximum report name length. */
export const MAX_REPORT_NAME_LENGTH = 100;

/** Maximum sections per report. */
export const MAX_SECTIONS_PER_REPORT = 20;

/** Maximum total reports. */
export const MAX_REPORTS = 50;

/** Maximum LLM output tokens. */
export const MAX_LLM_TOKENS = 2000;

/** Default LLM output tokens. */
export const DEFAULT_LLM_TOKENS = 500;

/** Default lookback hours for changes sections. */
export const DEFAULT_LOOKBACK_HOURS = 24;
