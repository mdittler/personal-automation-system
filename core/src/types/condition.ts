/**
 * Condition evaluator types.
 *
 * The condition evaluator reads human-readable markdown rule files,
 * checks conditions against current data, and triggers actions
 * (typically Telegram alerts).
 */

/** A parsed condition rule from a markdown rule file. */
export interface Rule {
	/** Unique rule ID (the ## heading in the rule file). */
	id: string;
	/** Human-readable condition expression. */
	condition: string;
	/** Data file paths to check (from **Data:** field). */
	dataSources: string[];
	/** Action to take when condition is met (from **Action:** field). */
	action: string;
	/** Human-readable cooldown string (e.g. "48 hours", "7 days"). */
	cooldown: string;
	/** Cooldown in milliseconds, parsed from the cooldown string. */
	cooldownMs: number;
	/** When this rule last fired, or null if never. */
	lastFired: Date | null;
	/** True if the rule ID has "fuzzy:" prefix (uses local LLM for evaluation). */
	isFuzzy: boolean;
}

/** Status of a rule, returned by getRuleStatus(). */
export interface RuleStatus {
	/** Rule ID. */
	id: string;
	/** When this rule last fired, or null if never. */
	lastFired: Date | null;
	/** Milliseconds until rule can fire again. 0 if ready. */
	cooldownRemaining: number;
	/** Whether the rule is active (not in cooldown). */
	isActive: boolean;
}

/** Result of evaluating a single rule. */
export interface RuleEvaluationResult {
	/** The rule that was evaluated. */
	ruleId: string;
	/** Whether the condition was met. */
	conditionMet: boolean;
	/** Whether the action was triggered (condition met AND not in cooldown). */
	actionTriggered: boolean;
	/** Error if evaluation failed. */
	error?: string;
}

/** Condition evaluator service provided to apps via CoreServices. */
export interface ConditionEvaluatorService {
	/** Programmatically check if a condition is true right now. */
	evaluate(ruleId: string): Promise<boolean>;

	/** Get the status of a rule (last fired, cooldown remaining, etc.). */
	getRuleStatus(ruleId: string): Promise<RuleStatus>;
}
