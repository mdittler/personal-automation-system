/**
 * Alert service.
 *
 * Manages alert definitions (CRUD), scheduled condition evaluation,
 * and action execution. Alerts are infrastructure-level, not apps.
 *
 * Storage:
 * - Definitions: data/system/alerts/{alert-id}.yaml
 * - History: data/system/alert-history/{id}/{date}_{timestamp}.md
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type {
	AlertAction,
	AlertDataSource,
	AlertDefinition,
	AlertEvaluationResult,
	AlertValidationError,
	WriteDataActionConfig,
	DispatchMessageActionConfig,
} from '../../types/alert.js';
import { ALERT_ID_PATTERN, MAX_ALERTS } from '../../types/alert.js';
import type { EventBusService, EventHandler } from '../../types/events.js';
import type { LLMService } from '../../types/llm.js';
import type { AudioService } from '../../types/audio.js';
import type { TelegramService } from '../../types/telegram.js';
import { ensureDir } from '../../utils/file.js';
import { generateFrontmatter, stripFrontmatter } from '../../utils/frontmatter.js';
import { readYamlFile, readYamlFileStrict, writeYamlFile } from '../../utils/yaml.js';
import { canFire, parseCooldown } from '../condition-evaluator/cooldown-tracker.js';
import { evaluateDeterministic, evaluateFuzzy } from '../condition-evaluator/evaluator.js';
import type { EvaluatorDeps } from '../condition-evaluator/evaluator.js';
import type { HouseholdService } from '../household/index.js';
import type { N8nDispatcher } from '../n8n/index.js';
import type { ReportService } from '../reports/index.js';
import { resolveDateTokens } from '../reports/section-collector.js';
import type { Router } from '../router/index.js';
import type { CronManager } from '../scheduler/cron-manager.js';
import type { UserManager } from '../user-manager/index.js';
import { resolveScopedDataDir } from '../data-store/paths.js';
import type { SpaceDefinition } from '../../types/spaces.js';
import { executeActions } from './alert-executor.js';
import { validateAlert } from './alert-validator.js';

const CRON_KEY_PREFIX = 'alerts';

/**
 * Thrown when an alert's household authorization check fails — e.g., delivery
 * spans multiple households, a data_source belongs to a foreign household, or
 * an action targets a user outside the alert's household.
 */
export class AlertScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AlertScopeError';
	}
}

export interface AlertServiceOptions {
	dataDir: string;
	llm: LLMService;
	telegram: TelegramService;
	userManager: UserManager;
	cronManager: CronManager;
	reportService: ReportService;
	timezone: string;
	logger: Logger;
	eventBus?: EventBusService;
	n8nDispatcher?: N8nDispatcher;
	audioService?: AudioService;
	router?: Router;
	/** Optional — when present, household boundary checks are enforced for delivery, data_sources, and actions. */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	/** Optional — when present, space_id data_sources are resolved to household/collaboration paths. */
	spaceService?: { getSpace(id: string): SpaceDefinition | null; isMember(spaceId: string, userId: string): boolean };
}

export class AlertService {
	private readonly alertsDir: string;
	private readonly historyDir: string;
	private readonly dataDir: string;
	private readonly llm: LLMService;
	private readonly telegram: TelegramService;
	private readonly userManager: UserManager;
	private readonly cronManager: CronManager;
	private readonly reportService: ReportService;
	private readonly timezone: string;
	private readonly logger: Logger;
	private readonly eventBus?: EventBusService;
	private readonly n8nDispatcher?: N8nDispatcher;
	private readonly audioService?: AudioService;
	private router?: Router;
	private readonly householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	private readonly spaceService?: { getSpace(id: string): SpaceDefinition | null; isMember(spaceId: string, userId: string): boolean };
	private readonly eventSubscriptions = new Map<
		string,
		{ eventName: string; handler: EventHandler }
	>();

	constructor(options: AlertServiceOptions) {
		this.dataDir = options.dataDir;
		this.alertsDir = join(options.dataDir, 'system', 'alerts');
		this.historyDir = join(options.dataDir, 'system', 'alert-history');
		this.llm = options.llm;
		this.telegram = options.telegram;
		this.userManager = options.userManager;
		this.cronManager = options.cronManager;
		this.reportService = options.reportService;
		this.timezone = options.timezone;
		this.logger = options.logger;
		this.eventBus = options.eventBus;
		this.n8nDispatcher = options.n8nDispatcher;
		this.audioService = options.audioService;
		this.router = options.router;
		this.householdService = options.householdService;
		this.spaceService = options.spaceService;
	}

	/**
	 * Set the router reference (needed to break circular dependency — router is created after AlertService).
	 */
	setRouter(router: Router): void {
		this.router = router;
	}

	/**
	 * Initialize: load all alert definitions and register enabled ones as cron jobs or event listeners.
	 */
	async init(): Promise<void> {
		const alerts = await this.listAlerts();
		let registered = 0;

		for (const alert of alerts) {
			if (alert.enabled && !alert._validationErrors?.length) {
				this.registerTrigger(alert);
				registered++;
			}
		}

		this.logger.info({ total: alerts.length, registered }, 'Alert service initialized');
	}

	// --- CRUD ---

	async listAlerts(): Promise<AlertDefinition[]> {
		try {
			await ensureDir(this.alertsDir);
			const files = await readdir(this.alertsDir);
			const alerts: AlertDefinition[] = [];

			for (const file of files) {
				if (!file.endsWith('.yaml')) continue;
				const result = await readYamlFileStrict(join(this.alertsDir, file));
				if (result === null) continue; // file disappeared
				if ('error' in result) {
					this.logger.warn({ file, error: result.error }, 'Skipping alert: YAML parse error');
					continue;
				}
				const validated = safeValidateAlert(result.data, this.userManager);
				if (validated === null) {
					this.logger.warn({ file }, 'Skipping alert: not a valid object');
					continue;
				}
				if (validated.errors.length > 0) {
					this.logger.warn(
						{ file, alertId: validated.alert.id, errors: validated.errors },
						'Alert loaded with validation errors — will not be scheduled',
					);
				}
				// Compute cooldownMs on load (even for invalid — it may still be displayable)
				if (validated.alert.cooldown) {
					validated.alert.cooldownMs = parseCooldown(validated.alert.cooldown);
				}
				alerts.push(validated.alert);
			}

			return alerts.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			this.logger.error({ error }, 'Failed to list alerts');
			return [];
		}
	}

	async getAlert(id: string): Promise<AlertDefinition | null> {
		if (!ALERT_ID_PATTERN.test(id)) return null;
		const filePath = join(this.alertsDir, `${id}.yaml`);
		const result = await readYamlFileStrict(filePath);
		if (result === null) return null;
		if ('error' in result) {
			this.logger.warn({ alertId: id, error: result.error }, 'Alert YAML parse error');
			return null;
		}
		const validated = safeValidateAlert(result.data, this.userManager);
		if (validated === null) return null;
		if (validated.errors.length > 0) {
			this.logger.warn(
				{ alertId: id, errors: validated.errors },
				'Alert loaded with validation errors',
			);
		}
		if (validated.alert.cooldown) {
			validated.alert.cooldownMs = parseCooldown(validated.alert.cooldown);
		}
		return validated.alert;
	}

	/**
	 * Save an alert definition. Validates first, returns errors if invalid.
	 * On success (empty errors array), writes to disk and updates cron job.
	 */
	async saveAlert(def: AlertDefinition): Promise<AlertValidationError[]> {
		const errors = validateAlert(def, this.userManager);
		if (errors.length > 0) return errors;

		// Block enabled event-triggered alerts when eventBus is not available
		const isEventTrigger = def.trigger?.type === 'event';
		if (isEventTrigger && def.enabled && !this.eventBus) {
			return [
				{
					field: 'trigger',
					message: 'Event-triggered alerts require the EventBus service, which is not available',
				},
			];
		}

		// Check alert count limit (only for new alerts)
		const existing = await this.getAlert(def.id);
		if (!existing) {
			const allAlerts = await this.listAlerts();
			if (allAlerts.length >= MAX_ALERTS) {
				return [{ field: 'id', message: `Maximum ${MAX_ALERTS} alerts allowed` }];
			}
		}

		def.updatedAt = new Date().toISOString();

		await ensureDir(this.alertsDir);
		// Strip transient runtime fields before persisting
		const { _validationErrors: _dropped, cooldownMs: _ms, ...persistable } = def;
		await writeYamlFile(join(this.alertsDir, `${def.id}.yaml`), persistable);

		// Update trigger (cron or event)
		this.syncTrigger(def);

		this.logger.info({ alertId: def.id, enabled: def.enabled }, 'Alert saved');
		return [];
	}

	async deleteAlert(id: string): Promise<boolean> {
		if (!ALERT_ID_PATTERN.test(id)) return false;

		const filePath = join(this.alertsDir, `${id}.yaml`);
		try {
			const { unlink } = await import('node:fs/promises');
			await unlink(filePath);
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') return false;
			throw error;
		}

		this.unregisterTrigger(id);
		this.logger.info({ alertId: id }, 'Alert deleted');
		return true;
	}

	// --- Evaluation ---

	/**
	 * Evaluate an alert by ID.
	 * @param alertId - ID of the alert to evaluate
	 * @param options.preview - If true, don't execute actions or save history
	 */
	async evaluate(alertId: string, options?: { preview?: boolean }): Promise<AlertEvaluationResult> {
		const alert = await this.getAlert(alertId);
		if (!alert) {
			return {
				alertId,
				conditionMet: false,
				actionTriggered: false,
				actionsExecuted: 0,
				error: 'Alert not found',
			};
		}

		if (alert._validationErrors?.length) {
			this.logger.error(
				{ alertId, errors: alert._validationErrors },
				'Refusing to evaluate alert with validation errors',
			);
			return {
				alertId,
				conditionMet: false,
				actionTriggered: false,
				actionsExecuted: 0,
				error: 'Alert has validation errors',
			};
		}

		const preview = options?.preview ?? false;

		this.logger.info({ alertId, preview }, 'Evaluating alert');

		try {
			// 0. Household authorization — derive alertHouseholdId and authorize scope.
			// Throws AlertScopeError when householdService is wired and constraints are violated.
			let alertHouseholdId: string | null;
			try {
				alertHouseholdId = this.authorizeAlertScope(alert);
			} catch (scopeErr) {
				const msg = scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
				this.logger.error({ alertId, error: msg }, 'Household scope authorization failed — refusing to evaluate');
				return {
					alertId,
					conditionMet: false,
					actionTriggered: false,
					actionsExecuted: 0,
					error: msg,
				};
			}

			// 1. Read data sources
			const data = await this.readDataSources(alert, alertHouseholdId);

			// 2. Evaluate condition
			const conditionMet = await this.checkCondition(alert, data);

			if (!conditionMet) {
				return {
					alertId,
					conditionMet: false,
					actionTriggered: false,
					actionsExecuted: 0,
				};
			}

			// 3. Preview mode — return result without executing actions or checking cooldown
			if (preview) {
				return {
					alertId,
					conditionMet: true,
					actionTriggered: false,
					actionsExecuted: 0,
				};
			}

			// 4. Check cooldown (skip in preview mode — preview only tests the condition)
			const lastFired = alert.lastFired ? new Date(alert.lastFired) : null;
			const cooldownMs = alert.cooldownMs ?? parseCooldown(alert.cooldown);

			if (!canFire(lastFired, cooldownMs)) {
				this.logger.debug({ alertId }, 'Alert in cooldown, skipping');
				return {
					alertId,
					conditionMet: true,
					actionTriggered: false,
					actionsExecuted: 0,
				};
			}

			// 5. Execute actions (pass evaluated data for template resolution)
			const execResult = await executeActions(
				alert.actions,
				alert.delivery,
				{
					telegram: this.telegram,
					reportService: this.reportService,
					logger: this.logger,
					llm: this.llm,
					dataDir: this.dataDir,
					audioService: this.audioService,
					router: this.router,
					timezone: this.timezone,
					householdService: this.householdService,
				},
				{ data, alertName: alert.name },
			);

			// 6. Update lastFired
			await this.updateLastFired(alert);

			// 7. Save to history
			const result: AlertEvaluationResult = {
				alertId,
				conditionMet: true,
				actionTriggered: true,
				actionsExecuted: execResult.successCount,
			};
			await this.saveToHistory(alertId, result);

			// 8. Emit event for webhook delivery
			this.eventBus?.emit('alert:fired', {
				alertId,
				conditionMet: true,
				actionsExecuted: execResult.successCount,
			});

			this.logger.info(
				{
					alertId,
					actionsExecuted: execResult.successCount,
					actionsFailed: execResult.failureCount,
				},
				'Alert fired',
			);

			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error({ alertId, error: errorMessage }, 'Alert evaluation failed');
			return {
				alertId,
				conditionMet: false,
				actionTriggered: false,
				actionsExecuted: 0,
				error: errorMessage,
			};
		}
	}

	// --- Private helpers ---

	/**
	 * Derive the alert's household ID from its delivery recipients and authorize
	 * all data_sources and actions against that household.
	 *
	 * Returns the household ID string when authorization succeeds, or null when
	 * householdService is not wired (transitional / pre-migration mode).
	 *
	 * Throws when:
	 * - HouseholdService is wired AND any delivery recipient has no household
	 * - HouseholdService is wired AND delivery recipients span multiple households
	 * - Any data_source or action targets a user/space in a different household
	 */
	private authorizeAlertScope(alert: AlertDefinition): string | null {
		if (!this.householdService) return null; // Not wired — skip household enforcement

		// Derive household from delivery recipients
		if (alert.delivery.length === 0) {
			this.logger.warn({ alertId: alert.id }, 'Alert has no delivery recipients — skipping household authorization');
			return null;
		}

		const householdIds = new Set<string>();
		for (const uid of alert.delivery) {
			const hh = this.householdService.getHouseholdForUser(uid);
			if (hh === null) {
				throw new AlertScopeError(
					`Alert "${alert.id}": delivery recipient "${uid}" has no household. Refusing to evaluate.`,
				);
			}
			householdIds.add(hh);
		}
		if (householdIds.size > 1) {
			throw new AlertScopeError(
				`Alert "${alert.id}": delivery recipients span multiple households (${[...householdIds].join(', ')}). Refusing to evaluate.`,
			);
		}
		const alertHouseholdId = [...householdIds][0]!;

		// Authorize each data_source
		for (const source of alert.condition.data_sources) {
			this.authorizeDataSource(alert.id, source, alertHouseholdId, alert.delivery);
		}

		// Authorize each action that targets a user_id or space_id
		for (const action of alert.actions) {
			this.authorizeAction(alert.id, action, alertHouseholdId);
		}

		return alertHouseholdId;
	}

	private authorizeDataSource(alertId: string, source: AlertDataSource, alertHouseholdId: string, deliveryUsers: string[]): void {
		if (source.space_id) {
			const spaceDef = this.spaceService?.getSpace(source.space_id) ?? null;
			if (!spaceDef) return; // Unknown space — let resolveScopedDataDir handle it
			if (spaceDef.kind === 'household') {
				if (spaceDef.householdId !== alertHouseholdId) {
					throw new AlertScopeError(
						`Alert "${alertId}": data_source space "${source.space_id}" belongs to household "${spaceDef.householdId ?? 'unknown'}", not "${alertHouseholdId}".`,
					);
				}
			} else if (spaceDef.kind === 'collaboration') {
				// Collaboration space: all alert delivery members must also be space members
				for (const uid of deliveryUsers) {
					if (!this.spaceService!.isMember(source.space_id, uid)) {
						throw new AlertScopeError(
							`Alert "${alertId}": data_source collaboration space "${source.space_id}" — delivery user "${uid}" is not a member.`,
						);
					}
				}
			}
		} else if (source.user_id) {
			const sourceHh = this.householdService!.getHouseholdForUser(source.user_id);
			if (sourceHh !== alertHouseholdId) {
				throw new AlertScopeError(
					`Alert "${alertId}": data_source user "${source.user_id}" belongs to household "${sourceHh ?? 'none'}", not "${alertHouseholdId}".`,
				);
			}
		}
	}


	private authorizeAction(alertId: string, action: AlertAction, alertHouseholdId: string): void {
		if (action.type === 'write_data') {
			const cfg = action.config as WriteDataActionConfig;
			const targetHh = this.householdService!.getHouseholdForUser(cfg.user_id);
			if (targetHh !== alertHouseholdId) {
				throw new AlertScopeError(
					`Alert "${alertId}": write_data action targets user "${cfg.user_id}" in household "${targetHh ?? 'none'}", not "${alertHouseholdId}".`,
				);
			}
		} else if (action.type === 'dispatch_message') {
			const cfg = action.config as DispatchMessageActionConfig;
			const targetHh = this.householdService!.getHouseholdForUser(cfg.user_id);
			if (targetHh !== alertHouseholdId) {
				throw new AlertScopeError(
					`Alert "${alertId}": dispatch_message action targets user "${cfg.user_id}" in household "${targetHh ?? 'none'}", not "${alertHouseholdId}".`,
				);
			}
		}
	}

	private async readDataSources(alert: AlertDefinition, alertHouseholdId: string | null): Promise<string> {
		const dataContents: string[] = [];

		for (const source of alert.condition.data_sources) {
			const resolvedPath = resolveDateTokens(source.path, this.timezone);

			// Build path using household-aware resolver.
			// alertHouseholdId: string → household path; null → legacy (service not wired).
			const baseDir = resolveScopedDataDir({
				dataDir: this.dataDir,
				appId: source.app_id,
				userId: source.user_id ?? undefined,
				spaceId: source.space_id ?? undefined,
				householdId: alertHouseholdId ?? undefined,
				spaceService: this.spaceService ?? undefined,
			});
			const fullPath = resolve(join(baseDir, resolvedPath));

			// Path traversal check
			if (!fullPath.startsWith(baseDir + sep)) {
				this.logger.warn(
					{ path: source.path, resolved: fullPath },
					'Path traversal attempt in alert data source',
				);
				continue;
			}

			try {
				const pathStats = await stat(fullPath);

				if (pathStats.isDirectory()) {
					// Directory: read the most recent file
					const content = await this.readMostRecentFile(fullPath);
					dataContents.push(content);
				} else {
					const raw = await readFile(fullPath, 'utf-8');
					dataContents.push(stripFrontmatter(raw));
				}
			} catch (error) {
				if (isNodeError(error) && error.code === 'ENOENT') {
					dataContents.push('');
				} else {
					throw error;
				}
			}
		}

		return dataContents.join('\n---\n');
	}

	/**
	 * Read the most recent file from a directory.
	 * Returns stripped content of the newest file by modification time, or empty string if no files.
	 */
	private async readMostRecentFile(dirPath: string): Promise<string> {
		const entries = await readdir(dirPath, { withFileTypes: true });
		const files: Array<{ name: string; mtime: number }> = [];

		for (const entry of entries) {
			if (!entry.isFile()) continue;
			try {
				const entryStats = await stat(join(dirPath, entry.name));
				files.push({ name: entry.name, mtime: entryStats.mtimeMs });
			} catch {
				// Skip entries we can't stat
			}
		}

		if (files.length === 0) return '';

		files.sort((a, b) => b.mtime - a.mtime);
		const raw = await readFile(join(dirPath, files[0]!.name), 'utf-8');
		return stripFrontmatter(raw);
	}

	private async checkCondition(alert: AlertDefinition, data: string): Promise<boolean> {
		// Build a minimal EvaluatorDeps for the standalone evaluator functions
		// We only need llm and logger — dataStore is not used since we already read data
		const deps: EvaluatorDeps = {
			dataStore: null as never, // Not used — data already read
			llm: this.llm,
			logger: this.logger,
		};

		if (alert.condition.type === 'fuzzy') {
			return evaluateFuzzy(alert.condition.expression, data, deps);
		}
		return evaluateDeterministic(alert.condition.expression, data, deps);
	}

	private async updateLastFired(alert: AlertDefinition): Promise<void> {
		try {
			const filePath = join(this.alertsDir, `${alert.id}.yaml`);
			const current = await readYamlFile<AlertDefinition>(filePath);
			if (current) {
				current.lastFired = new Date().toISOString();
				await writeYamlFile(filePath, current);
			}
		} catch (error) {
			this.logger.error(
				{ alertId: alert.id, error: error instanceof Error ? error.message : String(error) },
				'Failed to update lastFired',
			);
		}
	}

	private async saveToHistory(alertId: string, result: AlertEvaluationResult): Promise<void> {
		try {
			const alertHistoryDir = join(this.historyDir, alertId);
			await ensureDir(alertHistoryDir);

			const now = new Date().toISOString();
			const dateStr = now.slice(0, 10);
			const timeStr = now.slice(11, 23).replace(/[:.]/g, '-');
			const fileName = `${dateStr}_${timeStr}.md`;

			const frontmatter = generateFrontmatter({
				title: `Alert: ${alertId}`,
				date: dateStr,
				created: now,
				tags: ['pas/alert', `pas/alert/${alertId}`],
				type: 'alert',
				source: 'pas-alerts',
			});

			const content = [
				`# Alert: ${alertId}`,
				`**Fired at:** ${now}`,
				`**Condition met:** ${result.conditionMet}`,
				`**Actions triggered:** ${result.actionTriggered}`,
				`**Actions executed:** ${result.actionsExecuted}`,
				result.error ? `**Error:** ${result.error}` : '',
			]
				.filter(Boolean)
				.join('\n');

			const { atomicWrite } = await import('../../utils/file.js');
			await atomicWrite(join(alertHistoryDir, fileName), frontmatter + content);
		} catch (error) {
			this.logger.error({ error, alertId }, 'Failed to save alert history');
		}
	}

	/** Determine the effective trigger for an alert (backward compat). */
	private getEffectiveTrigger(
		alert: AlertDefinition,
	): { type: 'scheduled'; schedule: string } | { type: 'event'; event_name: string } {
		if (alert.trigger?.type === 'event') {
			if (alert.trigger.event_name) {
				return { type: 'event', event_name: alert.trigger.event_name };
			}
			this.logger.warn(
				{ alertId: alert.id },
				'Event trigger missing event_name, falling back to scheduled',
			);
		}
		// Default: scheduled (use trigger.schedule or top-level schedule)
		return { type: 'scheduled', schedule: alert.trigger?.schedule ?? alert.schedule };
	}

	private registerTrigger(alert: AlertDefinition): void {
		const trigger = this.getEffectiveTrigger(alert);

		if (trigger.type === 'event') {
			this.subscribeEvent(alert.id, trigger.event_name);
		} else {
			this.registerCronJob(alert, trigger.schedule);
		}
	}

	private syncTrigger(alert: AlertDefinition): void {
		this.unregisterTrigger(alert.id);
		if (alert.enabled) {
			this.registerTrigger(alert);
		}
	}

	private unregisterTrigger(alertId: string): void {
		// Unregister cron job (may not exist)
		const jobKey = `${CRON_KEY_PREFIX}:${alertId}`;
		this.cronManager.unregister(jobKey);
		// Unsubscribe from event bus (may not exist)
		this.unsubscribeEvent(alertId);
	}

	private registerCronJob(alert: AlertDefinition, schedule: string): void {
		this.cronManager.register(
			{
				id: alert.id,
				appId: CRON_KEY_PREFIX,
				cron: schedule,
				handler: 'alert-evaluator',
				description: `Alert: ${alert.name}`,
				userScope: 'system',
			},
			() => async () => {
				await this.executeTrigger(alert.id);
			},
		);

		this.logger.debug({ alertId: alert.id, schedule }, 'Alert cron job registered');
	}

	private subscribeEvent(alertId: string, eventName: string): void {
		if (!this.eventBus) {
			this.logger.warn({ alertId, eventName }, 'EventBus not available for event-triggered alert');
			return;
		}

		const handler: EventHandler = async () => {
			await this.executeTrigger(alertId);
		};

		this.eventBus.on(eventName, handler);
		this.eventSubscriptions.set(alertId, { eventName, handler });
		this.logger.debug({ alertId, eventName }, 'Alert event subscription registered');
	}

	/**
	 * Execute a triggered alert (cron or event).
	 * When n8n dispatch is configured, tries to dispatch first.
	 * Falls back to internal evaluation on dispatch failure.
	 */
	private async executeTrigger(alertId: string): Promise<void> {
		if (this.n8nDispatcher?.enabled) {
			const dispatched = await this.n8nDispatcher.dispatch({
				type: 'alert',
				id: alertId,
				action: 'evaluate',
			});
			if (dispatched) {
				return; // n8n will handle evaluation via API
			}
			this.logger.info({ alertId }, 'n8n dispatch failed, evaluating alert internally');
		}
		await this.evaluate(alertId);
	}

	private unsubscribeEvent(alertId: string): void {
		const sub = this.eventSubscriptions.get(alertId);
		if (!sub) return;
		if (this.eventBus) {
			this.eventBus.off(sub.eventName, sub.handler);
		}
		this.eventSubscriptions.delete(alertId);
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

/**
 * Safely validate an unknown value as an AlertDefinition.
 *
 * Returns null if the value is not even an object with an id string.
 * Returns the alert with _validationErrors attached (empty = valid).
 * Wraps validateAlert() in try-catch to guard against validator exceptions
 * on garbage primitive types.
 */
function safeValidateAlert(
	data: unknown,
	userManager: UserManager,
): { alert: AlertDefinition; errors: AlertValidationError[] } | null {
	if (typeof data !== 'object' || data === null) return null;
	const obj = data as Record<string, unknown>;
	if (typeof obj['id'] !== 'string' || !obj['id']) return null;

	const alert = data as AlertDefinition;
	let errors: AlertValidationError[];
	try {
		errors = validateAlert(alert, userManager);
	} catch {
		errors = [{ field: 'unknown', message: 'Validator threw an exception on malformed data' }];
	}

	alert._validationErrors = errors.length > 0 ? errors : undefined;
	return { alert, errors };
}
