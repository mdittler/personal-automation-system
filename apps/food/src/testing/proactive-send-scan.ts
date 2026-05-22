/**
 * Static scanner for the Food proactive-send guard.
 *
 * Flags every `telegram.send` / `telegram.sendWithButtons` call whose
 * enclosing function is one of `PROACTIVE_ENTRYPOINTS` — those handlers
 * MUST route sends through `sendProactiveMessage`
 * (apps/food/src/utils/proactive-message.ts) so the chatbot transcript
 * stays in sync via the AppOutboundBridge.
 *
 * Scoping rationale:
 *  - Entrypoint-scoped, not file-scoped. `apps/food/src/index.ts` mixes
 *    scheduled (proactive) jobs and reactive command/callback handlers;
 *    file-scope would false-positive on every reactive send.
 *  - Only the immediate enclosing function is inspected. We deliberately
 *    do NOT build a full call graph. If a small helper called only by a
 *    proactive entrypoint sneaks an unbridged send through, the fix is to
 *    add that helper to `PROACTIVE_ENTRYPOINTS` (or, better, route the
 *    helper through `sendProactiveMessage`). Build-failing CI keeps
 *    drift visible.
 *
 * Pattern reference: `core/src/testing/verdict-literal-scan.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * The closed set of Food functions that perform proactive (app-initiated,
 * non-reply) Telegram sends. Adding a new proactive cron handler? Add it
 * here AND route its sends through `sendProactiveMessage`.
 *
 * Confirmed by grep against `apps/food/src/` (2026-05-22):
 *  - 8 cron handlers from Task 1.3 (rating, perishable, leftover, freezer,
 *    defrost, cuisine, seasonal, cultural).
 *  - 5 helpers from Task 1.4: `finalizePlan` + `sendVotingMessages` in
 *    `handlers/voting.ts`; `handleWeeklyNutritionSummaryJob` in
 *    `handlers/nutrition-summary.ts`; `sendBatchPrepToMember` in
 *    `index.ts`; the inline `weekly-health` / `weekly-menu` sends inside
 *    `handleScheduledJob` already use `sendProactiveMessage` so the
 *    enclosing function is `handleScheduledJob` — which is therefore also
 *    in this set as a safety net.
 */
export const PROACTIVE_ENTRYPOINTS: ReadonlySet<string> = new Set([
	// 8 cron handlers (Task 1.3)
	'handleNightlyRatingPromptJob',
	'handlePerishableCheckJob',
	'handleLeftoverCheckJob',
	'handleFreezerCheckJob',
	'checkDefrostNeeded',
	'checkCuisineDiversity',
	'handleSeasonalNudgeJob',
	'handleCulturalCalendarJob',
	// 5 helpers migrated in Task 1.4
	'finalizePlan',
	'sendVotingMessages',
	'handleWeeklyNutritionSummaryJob',
	'sendBatchPrepToMember',
	// Safety net for inline weekly-health / weekly-menu / batch-prep sends
	// inside the AppModule's scheduled-job dispatcher.
	'handleScheduledJob',
]);

export interface ProactiveSendHit {
	file: string;
	line: number;
	fn: string;
}

interface FileSource {
	file: string;
	source: string;
}

/**
 * Exclude rules — paths (POSIX-normalized, relative to scan root) that
 * never contribute to scanner output. `__tests__` and `testing/` are
 * scaffolding (and the scanner itself); `utils/proactive-message.ts` is
 * the canonical helper whose body must call `telegram.send*` to do its job.
 */
function isExcluded(relPath: string): boolean {
	const posixPath = relPath.split(sep).join(posix.sep);
	if (posixPath.includes('/__tests__/') || posixPath.startsWith('__tests__/')) return true;
	if (posixPath.includes('/testing/') || posixPath.startsWith('testing/')) return true;
	if (posixPath === 'utils/proactive-message.ts') return true;
	return false;
}

/** Recursive `.ts` file enumerator — `node:fs` only, no extra deps. */
function listTsFiles(root: string): string[] {
	const out: string[] = [];
	function walk(dir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (name === 'node_modules' || name === 'dist') continue;
				walk(full);
			} else if (st.isFile() && name.endsWith('.ts') && !name.endsWith('.d.ts')) {
				out.push(full);
			}
		}
	}
	walk(root);
	return out;
}

/**
 * Does this CallExpression match `<...>.telegram.send(...)` or
 * `<...>.telegram.sendWithButtons(...)`? We match on the shape, not on
 * a particular receiver name, so `services.telegram.send(...)` and a
 * destructured `const { telegram } = services; telegram.send(...)` both
 * qualify (the latter via the bare-identifier branch).
 */
function isTelegramSendCall(call: ts.CallExpression): boolean {
	const callee = call.expression;
	if (!ts.isPropertyAccessExpression(callee)) return false;
	const methodName = callee.name.text;
	if (methodName !== 'send' && methodName !== 'sendWithButtons') return false;
	const receiver = callee.expression;
	if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'telegram') return true;
	if (ts.isIdentifier(receiver) && receiver.text === 'telegram') return true;
	return false;
}

/**
 * Walk up the parent chain and return the name of the enclosing function-like
 * node. For named declarations the name is direct; for arrow / function
 * expressions assigned to a `const X = …`, a property, or a class method,
 * we recover the binding/property name. Returns `undefined` if no name can
 * be resolved (anonymous IIFE, etc.) — such calls are not in our entrypoint
 * set so they fall through silently.
 */
function enclosingFunctionName(node: ts.Node): string | undefined {
	let cur: ts.Node | undefined = node.parent;
	while (cur) {
		if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) {
			return cur.name && ts.isIdentifier(cur.name) ? cur.name.text : undefined;
		}
		if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
			// Direct name on function expression: `const f = function fName() {}`
			if (ts.isFunctionExpression(cur) && cur.name && ts.isIdentifier(cur.name)) {
				return cur.name.text;
			}
			// `const X = (…) => …` / `const X = function () {}`
			const p = cur.parent;
			if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
				return p.name.text;
			}
			// `{ X: (…) => … }`
			if (p && ts.isPropertyAssignment(p)) {
				if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) {
					return p.name.text;
				}
			}
			// `export const X: AppModule['handleScheduledJob'] = async (…) => …`
			// — handled by the VariableDeclaration branch above.
			return undefined;
		}
		cur = cur.parent;
	}
	return undefined;
}

/** Core scan over a list of in-memory sources. */
export function scanFoodProactiveSendsFromSources(sources: FileSource[]): ProactiveSendHit[] {
	const hits: ProactiveSendHit[] = [];
	for (const { file, source } of sources) {
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && isTelegramSendCall(node)) {
				const fnName = enclosingFunctionName(node);
				if (fnName && PROACTIVE_ENTRYPOINTS.has(fnName)) {
					const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
					hits.push({ file, line, fn: fnName });
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return hits;
}

/**
 * Scan every `.ts` file under `root` (default `apps/food/src`), skipping
 * excluded paths, and return one hit per offending call site.
 */
export function scanFoodProactiveSends(root = 'apps/food/src'): ProactiveSendHit[] {
	const files = listTsFiles(root);
	const sources: FileSource[] = [];
	for (const abs of files) {
		const rel = relative(root, abs);
		if (isExcluded(rel)) continue;
		const source = readFileSync(abs, 'utf8');
		sources.push({ file: rel.split(sep).join(posix.sep), source });
	}
	return scanFoodProactiveSendsFromSources(sources);
}
