/**
 * Dispatch-site regression test for per-user config runtime propagation.
 *
 * The fix (2026-04-09) introduced `requestContext.run({ userId }, handler)`
 * wraps at every infrastructure dispatch point. Without these wraps,
 * `AppConfigService.get()` silently returns the manifest default instead
 * of the calling user's override — a bug that is invisible at runtime
 * because everything still "works", just with the wrong values.
 *
 * Most dispatch sites have behavioral regression tests elsewhere:
 *
 * - `core/src/api/__tests__/messages.test.ts` — API /messages route
 *   behavioral test: `dispatches inside requestContext so config.get
 *   resolves per-user`
 * - `core/src/services/alerts/__tests__/alert-executor-enhanced.test.ts`
 *   — alert dispatch_message behavioral test: `dispatches inside
 *   requestContext so downstream config.get is per-user`
 * - `core/src/services/scheduler/__tests__/per-user-dispatch.test.ts`
 *   — scheduled-job `user_scope: all` behavioral test
 * - `core/src/services/config/__tests__/per-user-runtime.integration.test.ts`
 *   — end-to-end config propagation inside requestContext.run
 *
 * The four dispatch sites inside `core/src/bootstrap.ts` (message, photo,
 * verification callback, app callback) live inside inline telegram bot
 * callback registrations and cannot be independently imported for
 * behavioral testing without standing up the entire bootstrap composition
 * root. This file closes that gap with a structural source-scan: it
 * reads bootstrap.ts and asserts that every known dispatch call site is
 * wrapped in `requestContext.run`.
 *
 * If a future refactor reshapes these dispatch sites, this test will
 * fail loudly rather than silently allowing the wrap to disappear. The
 * failure message points to the scan target and the exact invariant
 * being checked.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function readSource(relative: string): Promise<string> {
	const path = join(__dirname, '..', relative);
	return readFile(path, 'utf8');
}

/**
 * Strip line comments and block comments from TypeScript source so that
 * commented-out code or documentation referencing a dispatch pattern
 * cannot satisfy the scan and accidentally pass the test.
 */
function stripComments(source: string): string {
	// Remove /* ... */ block comments (non-greedy, multiline)
	const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
	// Remove // line comments (up to end of line)
	return noBlock.replace(/\/\/.*$/gm, '');
}

describe('dispatch-site requestContext wraps', () => {
	describe('bootstrap.ts', () => {
		it('every router.routeMessage call is wrapped in requestContext.run', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// Count raw router.routeMessage(...) invocations.
			const totalCalls = source.match(/\brouter\.routeMessage\s*\(/g) ?? [];

			// Count calls that are the immediate callee of a requestContext.run
			// whose store object declares a userId key. The pattern allows
			// arbitrary whitespace and optional arrow-body prefix.
			const wrappedCalls =
				source.match(
					/requestContext\.run\s*\(\s*\{[^}]*\buserId\b[^}]*\}\s*,\s*\(\s*\)\s*=>\s*router\.routeMessage\s*\(/g,
				) ?? [];

			expect(totalCalls.length).toBeGreaterThan(0);
			expect(wrappedCalls.length).toBe(totalCalls.length);
		});

		it('every router.routePhoto call is wrapped in requestContext.run', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const totalCalls = source.match(/\brouter\.routePhoto\s*\(/g) ?? [];
			const wrappedCalls =
				source.match(
					/requestContext\.run\s*\(\s*\{[^}]*\buserId\b[^}]*\}\s*,\s*\(\s*\)\s*=>\s*router\.routePhoto\s*\(/g,
				) ?? [];

			expect(totalCalls.length).toBeGreaterThan(0);
			expect(wrappedCalls.length).toBe(totalCalls.length);
		});

		it('the verification-callback dispatch block is wrapped in requestContext.run', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// The verification callback block dispatches to either chatbotApp
			// or the resolved appEntry inside an async IIFE passed to
			// requestContext.run. We assert the wrap appears in the 'rv:'
			// branch by searching for the characteristic handoff between
			// resolveCallback and requestContext.run.
			// I-6: the rv: callback block now includes householdId in the context object
			const rvBranch = source.match(
				/resolveCallback[\s\S]{0,700}requestContext\.run\s*\(\s*\{\s*userId/,
			);
			expect(rvBranch).not.toBeNull();
		});

		it('the app-callback dispatch (handleCallbackQuery) is wrapped in requestContext.run', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// The 'app:' callback branch ends with
			//   await requestContext.run({ userId, householdId: ... }, () => handler(customData, callbackCtx));
			// I-6: householdId is now also set in the context object.
			// We assert that requestContext.run is called with userId and that handler() is invoked.
			const appCallbackWrap = source.match(
				/requestContext\.run\s*\(\s*\{[\s\S]{0,120}userId[\s\S]{0,200}\(\s*\)\s*=>\s*handler\s*\(/,
			);
			expect(appCallbackWrap).not.toBeNull();
		});

		it('imports requestContext from the context module (not from llm/)', async () => {
			const source = await readSource('bootstrap.ts');
			expect(source).toContain("from './services/context/request-context.js'");
			// The old llmContext import path must not reappear
			expect(source).not.toMatch(/from\s+['"][^'"]*llm\/llm-context/);
		});

		it('access check runs BEFORE resolveCallback in the rv: branch (H1 fix)', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// The isEnabled guard must appear before resolveCallback so the pending
			// entry is NOT consumed when access is denied. We assert that within
			// the rv: branch, isEnabled(...) precedes resolveCallback(...).
			const accessBeforeResolve = source.match(
				/isEnabled\s*\([^)]*\)[\s\S]{0,600}resolveCallback\s*\(/,
			);
			expect(accessBeforeResolve).not.toBeNull();
		});

		it('no chatbot exemption in the rv: branch access check (L4 fix)', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// The old code skipped the access check for chatbot with:
			//   if (chosenAppId !== 'chatbot') { ... isEnabled ... }
			// All apps including chatbot must now pass through the same check.
			// We assert the exemption pattern does not appear near the rv: branch.
			const rvIdx = source.indexOf("data.startsWith('rv:')");
			expect(rvIdx).toBeGreaterThan(-1);
			const rvSection = source.slice(rvIdx, rvIdx + 1000);
			expect(rvSection).not.toMatch(/chosenAppId\s*!==\s*['"]chatbot['"]/);
		});

		it('answeredCallback flag prevents double answerCallbackQuery (M2 fix)', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			// The denial path sets answeredCallback = true and calls
			// answerCallbackQuery with a user-facing text message. The finally
			// block checks this flag before calling the bare answerCallbackQuery.
			expect(source).toMatch(/answeredCallback\s*=\s*true/);
			expect(source).toMatch(/answerCallbackQuery\s*\(\s*\{[^}]*You no longer have access/);
			expect(source).toMatch(/if\s*\(\s*!answeredCallback\s*\)[\s\S]{0,200}answerCallbackQuery/);
		});
	});

	describe('api/routes/messages.ts', () => {
		it('wraps router.routeMessage in requestContext.run', async () => {
			const source = stripComments(await readSource('api/routes/messages.ts'));
			// Pattern allows extra fields (e.g. householdId) alongside userId in the context object
			const wrapped = source.match(
				/requestContext\.run\s*\(\s*\{[^}]*userId[^}]*\}\s*,\s*\(\s*\)\s*=>\s*router\.routeMessage\s*\(/,
			);
			expect(wrapped).not.toBeNull();
		});
	});

	describe('services/alerts/alert-executor.ts', () => {
		it('wraps deps.router.routeMessage in requestContext.run with the action user_id', async () => {
			const source = stripComments(await readSource('services/alerts/alert-executor.ts'));
			// Pattern allows extra fields (e.g. householdId) alongside userId in the context object
			const wrapped = source.match(
				/requestContext\.run\s*\(\s*\{[^}]*userId:\s*config\.user_id[^}]*\}\s*,\s*\(\s*\)\s*=>\s*deps\.router[!\.]*routeMessage\s*\(/,
			);
			expect(wrapped).not.toBeNull();
		});
	});

	describe('services/llm/providers/base-provider.ts', () => {
		it('reads userId via getCurrentUserId from the unified request-context module', async () => {
			const source = await readSource('services/llm/providers/base-provider.ts');
			// LLM cost attribution must consume the same ALS as AppConfigService.
			// Breaking this import means cost attribution drifts from config
			// reads, which is the bug the unification was meant to prevent.
			expect(source).toContain("from '../../context/request-context.js'");
			expect(source).toMatch(/\bgetCurrentUserId\s*\(/);
		});
	});

	describe('bootstrap.ts — F37: condition-eval service name', () => {
		it('uses "condition-eval" (not "condition-evaluator") to guard conditionEvaluator injection', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));
			// The schema only allows "condition-eval" in requirements.services.
			// If bootstrap checks for "condition-evaluator" instead, no app can ever
			// receive the conditionEvaluator service.
			expect(source).toMatch(/declaredServices\.has\s*\(\s*['"]condition-eval['"]\s*\)/);
			expect(source).not.toMatch(/declaredServices\.has\s*\(\s*['"]condition-evaluator['"]\s*\)/);
		});
	});
});
