/**
 * Agent bucket task schema (REQ-REG-AGENT-001). One task per PersonaCase:
 * `inputs[0].payload` is an `AgentTaskPayload`, `inputs[0].expected` an
 * `AgentExpectation`. Grading is outcome-only — never the tool path
 * (doctrine item 7).
 */

export const AGENT_CATEGORIES = [
	'single-fact',
	'aggregation',
	'out-of-distribution',
	'write',
	'no-tool',
	'multi-turn',
	'photo',
	'injection',
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/** `regression` should stay near 100%; `capability` starts low and measures progress. */
export type AgentTaskSet = 'regression' | 'capability';

/** A user turn: typed text, or a photo fixture (repo-relative path) with optional caption. */
export type AgentTurn = { text: string } | { photo: string; caption?: string };

export type FactCheck =
	| { kind: 'number'; value: number; label: string }
	| { kind: 'text'; value: string; label: string }
	| { kind: 'any-text'; values: string[]; label: string }
	| { kind: 'date'; value: string; label: string };

/** Assert on a list inside a YAML file body (e.g. grocery `items[].name`). */
export interface ItemsCheck {
	key: string;
	field: string;
	/** Case-insensitive regex source matched against `item[field]`. */
	match: string;
	present: boolean;
	/** When present, the exact number of matching items. */
	count?: number;
}

export interface DataStateCheck {
	/** Relative to the data dir; `{householdId}` / `{userId}` placeholders; `*` allowed in the last segment. */
	path: string;
	exists?: boolean;
	/** Case-insensitive; at least one matching file must contain every string. */
	contains?: string[];
	/** Case-insensitive regex sources; each must match some line of some matching file. */
	lineRegex?: string[];
	items?: ItemsCheck;
}

export interface AgentTaskPayload {
	turns: AgentTurn[];
	/** Directory name under `regression/fixtures/agent/overlays/` copied over the base seed. */
	overlay?: string;
}

export interface AgentExpectation {
	set: AgentTaskSet;
	category: AgentCategory;
	facts?: FactCheck[];
	/** Which replies the facts are checked against (default `last-turn`). */
	factsFrom?: 'last-turn' | 'all-turns';
	/** Case-insensitive substrings that must not appear in any reply. */
	forbidden?: string[];
	dataState?: DataStateCheck[];
	/** Files, or directories ending in `/`, whose content must be byte-identical before and after. */
	unchanged?: string[];
	/** Fail if the bot sends any message to a user other than the requester. */
	noExternalMessages?: boolean;
}

export const FOOD = 'households/{householdId}/shared/food';
export const USER = 'households/{householdId}/users/{userId}';
