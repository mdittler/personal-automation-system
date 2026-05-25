/**
 * Static scanner for the Food proactive-send guard.
 *
 * Strategy B (2026-05-24): transitive call-graph reachability. From each
 * entrypoint in `PROACTIVE_ENTRYPOINTS`, walk the call graph using the
 * TypeScript type checker (so cross-file helpers resolve correctly), and
 * flag any reachable `telegram.send*` call site. Sanctioned helpers in
 * `utils/proactive-message.ts` are excluded.
 *
 * This replaces the prior Strategy A "direct helper enumeration" — adding
 * a new proactive helper no longer requires editing this file. The
 * in-memory `scanFoodProactiveSendsFromSources` API is retained as a thin
 * Strategy-A-style scanner for the guard self-test fixture only.
 *
 * Implementation: `proactive-send-call-graph.ts` (Strategy B).
 */

import * as ts from 'typescript';
import { type ProactiveSendHit, findReachableSends } from './proactive-send-call-graph.js';

/**
 * The closed set of Food functions that perform proactive (app-initiated,
 * non-reply) Telegram sends. Adding a new proactive cron handler? Add it
 * here AND route its sends through `sendProactiveMessage`. Strategy B
 * automatically chases any helper reachable from these entrypoints.
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

export type { ProactiveSendHit };

interface InMemoryFileSource {
	file: string;
	source: string;
}

/**
 * In-memory single-file scanner — Strategy A behavior preserved purely
 * for the guard self-test fixture (Codex #16). Walks each provided
 * source as a single `ts.SourceFile`, flags telegram.send* calls whose
 * immediate enclosing function is named in `PROACTIVE_ENTRYPOINTS`.
 *
 * NOT used for the real sweep — that goes through `findReachableSends`
 * (Strategy B, transitive call graph).
 */
export function scanFoodProactiveSendsFromSources(
	sources: InMemoryFileSource[],
): ProactiveSendHit[] {
	const hits: ProactiveSendHit[] = [];
	for (const { file, source } of sources) {
		const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node)) {
				const callee = node.expression;
				if (ts.isPropertyAccessExpression(callee)) {
					const methodName = callee.name.text;
					const isSend =
						methodName === 'send' ||
						methodName === 'sendWithButtons' ||
						methodName === 'sendPhoto' ||
						methodName === 'sendOptions';
					if (isSend) {
						const receiver = callee.expression;
						const isTelegramReceiver =
							(ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'telegram') ||
							(ts.isIdentifier(receiver) && receiver.text === 'telegram');
						if (isTelegramReceiver) {
							const fn = enclosingFn(node);
							if (fn && PROACTIVE_ENTRYPOINTS.has(fn)) {
								const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
								hits.push({ file, line, fn });
							}
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return hits;
}

function enclosingFn(node: ts.Node): string | undefined {
	let cur: ts.Node | undefined = node.parent;
	while (cur) {
		if (ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) {
			return cur.name && ts.isIdentifier(cur.name) ? cur.name.text : undefined;
		}
		if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
			if (ts.isFunctionExpression(cur) && cur.name && ts.isIdentifier(cur.name)) {
				return cur.name.text;
			}
			const p = cur.parent;
			if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
			if (p && ts.isPropertyAssignment(p)) {
				if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
			}
			return undefined;
		}
		cur = cur.parent;
	}
	return undefined;
}

/**
 * Real production sweep — Strategy B transitive call-graph reachability.
 * Default root: `apps/food/src` (the closest production layout match).
 */
export function scanFoodProactiveSends(projectRoot = 'apps/food/src'): ProactiveSendHit[] {
	return findReachableSends({
		projectRoot,
		entrypoints: [...PROACTIVE_ENTRYPOINTS],
	});
}
