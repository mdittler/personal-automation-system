/**
 * Report definition validator.
 *
 * Validates a ReportDefinition and returns an array of errors.
 * Empty array means the definition is valid.
 */

import cron from 'node-cron';
import type {
	AppDataSectionConfig,
	ChangesSectionConfig,
	ContextSectionConfig,
	CustomSectionConfig,
	ReportDefinition,
	ReportValidationError,
	SectionType,
} from '../../types/report.js';
import {
	MAX_LLM_TOKENS,
	MAX_REPORT_ID_LENGTH,
	MAX_REPORT_NAME_LENGTH,
	MAX_SECTIONS_PER_REPORT,
	REPORT_ID_PATTERN,
} from '../../types/report.js';
import { SPACE_ID_PATTERN } from '../../types/spaces.js';
import type { UserManager } from '../user-manager/index.js';

const VALID_SECTION_TYPES: SectionType[] = ['changes', 'app-data', 'context', 'custom'];
const VALID_TIERS = ['fast', 'standard', 'reasoning'];
const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a report definition. Returns an array of errors (empty = valid).
 */
export function validateReport(
	def: ReportDefinition,
	userManager: UserManager,
): ReportValidationError[] {
	const errors: ReportValidationError[] = [];

	// ID validation
	if (!def.id) {
		errors.push({ field: 'id', message: 'Report ID is required' });
	} else {
		if (!REPORT_ID_PATTERN.test(def.id)) {
			errors.push({
				field: 'id',
				message:
					'Report ID must start with a letter and contain only lowercase letters, digits, and hyphens',
			});
		}
		if (def.id.length > MAX_REPORT_ID_LENGTH) {
			errors.push({
				field: 'id',
				message: `Report ID must be at most ${MAX_REPORT_ID_LENGTH} characters`,
			});
		}
	}

	// Name validation
	if (!def.name || !def.name.trim()) {
		errors.push({ field: 'name', message: 'Report name is required' });
	} else if (def.name.length > MAX_REPORT_NAME_LENGTH) {
		errors.push({
			field: 'name',
			message: `Report name must be at most ${MAX_REPORT_NAME_LENGTH} characters`,
		});
	}

	// Schedule validation
	if (!def.schedule) {
		errors.push({ field: 'schedule', message: 'Schedule (cron expression) is required' });
	} else if (!cron.validate(def.schedule)) {
		errors.push({ field: 'schedule', message: 'Invalid cron expression' });
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

	// Sections validation
	if (!Array.isArray(def.sections) || def.sections.length === 0) {
		errors.push({ field: 'sections', message: 'At least one section is required' });
	} else {
		if (def.sections.length > MAX_SECTIONS_PER_REPORT) {
			errors.push({
				field: 'sections',
				message: `Maximum ${MAX_SECTIONS_PER_REPORT} sections allowed`,
			});
		}
		for (let i = 0; i < def.sections.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: bounded by loop
			const section = def.sections[i]!;
			const prefix = `sections[${i}]`;

			if (!VALID_SECTION_TYPES.includes(section.type)) {
				errors.push({
					field: `${prefix}.type`,
					message: `Invalid section type "${section.type}". Must be one of: ${VALID_SECTION_TYPES.join(', ')}`,
				});
				continue;
			}

			if (!section.label || !section.label.trim()) {
				errors.push({ field: `${prefix}.label`, message: 'Section label is required' });
			}

			validateSectionConfig(section.type, section.config, prefix, errors);
		}
	}

	// LLM config validation
	if (def.llm) {
		if (def.llm.tier && !VALID_TIERS.includes(def.llm.tier)) {
			errors.push({
				field: 'llm.tier',
				message: `Invalid LLM tier "${def.llm.tier}". Must be one of: ${VALID_TIERS.join(', ')}`,
			});
		}
		if (def.llm.max_tokens !== undefined) {
			if (!Number.isInteger(def.llm.max_tokens) || def.llm.max_tokens < 1) {
				errors.push({
					field: 'llm.max_tokens',
					message: 'max_tokens must be a positive integer',
				});
			} else if (def.llm.max_tokens > MAX_LLM_TOKENS) {
				errors.push({
					field: 'llm.max_tokens',
					message: `max_tokens must be at most ${MAX_LLM_TOKENS}`,
				});
			}
		}
	}

	return errors;
}

function validateSectionConfig(
	type: SectionType,
	config: unknown,
	prefix: string,
	errors: ReportValidationError[],
): void {
	if (!config || typeof config !== 'object') {
		errors.push({ field: `${prefix}.config`, message: 'Section config is required' });
		return;
	}

	switch (type) {
		case 'changes':
			validateChangesConfig(config as ChangesSectionConfig, prefix, errors);
			break;
		case 'app-data':
			validateAppDataConfig(config as AppDataSectionConfig, prefix, errors);
			break;
		case 'context':
			validateContextConfig(config as ContextSectionConfig, prefix, errors);
			break;
		case 'custom':
			validateCustomConfig(config as CustomSectionConfig, prefix, errors);
			break;
	}
}

function validateChangesConfig(
	config: ChangesSectionConfig,
	prefix: string,
	errors: ReportValidationError[],
): void {
	if (config.lookback_hours !== undefined) {
		if (typeof config.lookback_hours !== 'number' || config.lookback_hours < 1) {
			errors.push({
				field: `${prefix}.config.lookback_hours`,
				message: 'lookback_hours must be a positive number',
			});
		}
	}
	if (config.app_filter !== undefined && !Array.isArray(config.app_filter)) {
		errors.push({
			field: `${prefix}.config.app_filter`,
			message: 'app_filter must be an array',
		});
	}
}

function validateAppDataConfig(
	config: AppDataSectionConfig,
	prefix: string,
	errors: ReportValidationError[],
): void {
	if (!config.app_id) {
		errors.push({ field: `${prefix}.config.app_id`, message: 'app_id is required' });
	} else if (!APP_ID_PATTERN.test(config.app_id)) {
		errors.push({
			field: `${prefix}.config.app_id`,
			message:
				'app_id must start with a letter and contain only lowercase letters, digits, and hyphens',
		});
	}

	// Validate space_id format when present
	if (config.space_id !== undefined) {
		if (!SPACE_ID_PATTERN.test(config.space_id)) {
			errors.push({
				field: `${prefix}.config.space_id`,
				message:
					'space_id must start with a letter and contain only lowercase letters, digits, and hyphens',
			});
		}
	}

	// user_id is required only when space_id is NOT set
	if (!config.space_id) {
		if (!config.user_id) {
			errors.push({
				field: `${prefix}.config.user_id`,
				message: 'user_id is required when space_id is not set',
			});
		} else if (!USER_ID_PATTERN.test(config.user_id)) {
			errors.push({
				field: `${prefix}.config.user_id`,
				message: 'user_id contains invalid characters',
			});
		}
	} else if (config.user_id && !USER_ID_PATTERN.test(config.user_id)) {
		// If user_id is provided alongside space_id, still validate format
		errors.push({
			field: `${prefix}.config.user_id`,
			message: 'user_id contains invalid characters',
		});
	}

	if (!config.path) {
		errors.push({ field: `${prefix}.config.path`, message: 'path is required' });
	} else {
		if (config.path.includes('..')) {
			errors.push({
				field: `${prefix}.config.path`,
				message: 'path must not contain ".."',
			});
		}
		if (config.path.startsWith('/') || config.path.startsWith('\\')) {
			errors.push({
				field: `${prefix}.config.path`,
				message: 'path must be relative (not start with / or \\)',
			});
		}
		if (config.path.includes('\\')) {
			errors.push({
				field: `${prefix}.config.path`,
				message: 'path must use forward slashes',
			});
		}
	}
}

function validateContextConfig(
	config: ContextSectionConfig,
	prefix: string,
	errors: ReportValidationError[],
): void {
	if (!config.key_prefix || !config.key_prefix.trim()) {
		errors.push({
			field: `${prefix}.config.key_prefix`,
			message: 'key_prefix is required',
		});
	}
}

function validateCustomConfig(
	config: CustomSectionConfig,
	prefix: string,
	errors: ReportValidationError[],
): void {
	if (!config.text || !config.text.trim()) {
		errors.push({
			field: `${prefix}.config.text`,
			message: 'text is required for custom sections',
		});
	}
}
