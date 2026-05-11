/**
 * PersonaCase schema validator (REQ-REG-014).
 *
 * Runs at case-load time to reject malformed case files before the orchestrator
 * sees them. This is the first line of defense against bad input — author errors
 * (typos, copy-paste mistakes) and accidentally hostile values (traversal paths,
 * Windows separators, absolute paths) are caught here, not after a stale cache
 * read or a fixture write.
 *
 * Per REQ-REG-014, oracle: 'judge' is reserved (always rejected). Chunk C
 * lifts the rubric ban on chatbot cases (REQ-REG-005); judge stays reserved.
 */

import type { PersonaCase } from './types.js';

const ID_RE = /^[a-z][a-z0-9-]{0,127}$/;
const BUCKETS: PersonaCase['bucket'][] = ['receipt', 'chatbot', 'recall', 'routing'];
const VALID_ROUTING_TARGETS = new Set<string>(['food-shadow', 'session-control', 'pas']);

function isPosixRepoRelative(p: string): boolean {
	if (!p) return false;
	if (p.includes('\\')) return false; // reject Windows separators
	if (/^[A-Za-z]:[/\\]/.test(p)) return false; // C:\ or C:/
	if (p.startsWith('/')) return false;
	if (p.split('/').includes('..')) return false;
	return true;
}

export function validatePersonaCase(c: PersonaCase): void {
	if (!c.id || !ID_RE.test(c.id)) {
		throw new Error(
			`PersonaCase.id must match ${ID_RE.source} (lowercase, dash-separated): ${JSON.stringify(c.id)}`,
		);
	}
	if (!BUCKETS.includes(c.bucket)) {
		throw new Error(`PersonaCase.bucket invalid: ${JSON.stringify(c.bucket)}`);
	}
	if (c.bucket === 'routing') {
		if (typeof c.routingTarget !== 'string') {
			throw new Error(
				`PersonaCase.routingTarget is required when bucket === 'routing' (case: ${c.id})`,
			);
		}
		if (!VALID_ROUTING_TARGETS.has(c.routingTarget)) {
			throw new Error(
				`PersonaCase.routingTarget invalid: ${JSON.stringify(c.routingTarget)} (must be one of food-shadow, session-control, pas)`,
			);
		}
	} else if (c.routingTarget !== undefined) {
		throw new Error(
			`PersonaCase.routingTarget only allowed when bucket === 'routing' (got bucket="${c.bucket}", routingTarget="${c.routingTarget}")`,
		);
	}
	if (!Array.isArray(c.coverage) || c.coverage.length === 0) {
		throw new Error('PersonaCase.coverage must be a non-empty array');
	}
	for (const p of c.coverage) {
		if (typeof p !== 'string' || !isPosixRepoRelative(p)) {
			throw new Error(
				`PersonaCase.coverage entry must be repo-relative POSIX path (no traversal/absolute): ${JSON.stringify(p)}`,
			);
		}
	}
	if (!Number.isFinite(c.budgetUsd) || c.budgetUsd <= 0) {
		throw new Error(`PersonaCase.budgetUsd must be a finite positive number: ${c.budgetUsd}`);
	}
	if (!Array.isArray(c.inputs) || c.inputs.length === 0) {
		throw new Error('PersonaCase.inputs must be non-empty');
	}
	if (c.oracle === 'judge') {
		throw new Error(`PersonaCase.oracle 'judge' is reserved (REQ-REG-014)`);
	}
	if (c.oracle === 'rubric') {
		if (c.bucket !== 'chatbot') {
			throw new Error(
				`PersonaCase.oracle 'rubric' is only allowed on bucket 'chatbot' (got bucket="${c.bucket}", case: ${c.id})`,
			);
		}
		if (typeof c.rubric !== 'string') {
			throw new Error(`PersonaCase.oracle 'rubric' field is required (case: ${c.id})`);
		}
		if (c.rubric.trim().length === 0) {
			throw new Error(`PersonaCase.rubric must be non-empty (case: ${c.id})`);
		}
		return;
	}
	if (c.oracle !== 'structural') {
		throw new Error(
			`PersonaCase.oracle must be 'structural' or 'rubric': ${JSON.stringify(c.oracle)}`,
		);
	}
}
