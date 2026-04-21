/**
 * Dispatch-site regression test for per-user config runtime propagation.
 *
 * The fix (2026-04-09) introduced `requestContext.run({ userId }, handler)`
 * wraps at every infrastructure dispatch point. Without these wraps,
 * `AppConfigService.get()` silently returns the manifest default instead
 * of the calling user's override — a bug that is invisible at runtime
 * because everything still "works", just with the wrong values.
 *
 * D5c Chunk A (2026-04-20) extended each wrap to include `householdId` so
 * the per-household LLM governance layer (Chunk C) can attribute every LLM
 * call to the correct household without needing separate wiring.
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
 * The five dispatch sites inside `core/src/bootstrap.ts` (message, photo,
 * verification callback, onboard callback, app callback) live inside inline
 * telegram bot callback registrations and cannot be independently imported
 * for behavioral testing without standing up the entire bootstrap composition
 * root. This file closes that gap with a structural source-scan: it reads
 * bootstrap.ts and asserts that every known dispatch call site is wrapped in
 * `requestContext.run` with BOTH `userId` and `householdId`.
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

/**
 * Lookahead-based pattern that matches a single-line `{...}` object literal
 * containing BOTH `userId` and `householdId` keys in any order.
 *
 * `householdId` is matched as a property key only — either shorthand
 * (`{..., householdId, ...}`, preceded by `{` or `,`) or explicit
 * (`householdId: value`). This prevents a regression like
 * `{ userId, hh: householdId }` from satisfying the guard even though
 * the ALS store would lack a `householdId` property.
 *
 * `[^}]*` intentionally restricts to single-line objects: multi-line wraps
 * will cause the test to fail loudly, signalling that the pattern needs an
 * explicit update — the desired behaviour for structural guard tests.
 */
const hasBothKeys = String.raw`\{(?=[^}]*\buserId\b)(?=[^}]*(?:[{,]\s*\bhouseholdId\b|\bhouseholdId\s*:))[^}]*\}`;

describe('dispatch-site requestContext wraps', () => {
	describe('bootstrap.ts', () => {
		it('every router.routeMessage call is wrapped in requestContext.run with userId and householdId', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const totalCalls = source.match(/\brouter\.routeMessage\s*\(/g) ?? [];

			// Require both userId AND householdId in the context object (any field order).
			const wrappedCalls =
				source.match(
					new RegExp(
						String.raw`requestContext\.run\s*\(\s*` +
							hasBothKeys +
							String.raw`\s*,\s*\(\s*\)\s*=>\s*router\.routeMessage\s*\(`,
						'g',
					),
				) ?? [];

			expect(totalCalls.length).toBeGreaterThan(0);
			expect(wrappedCalls.length).toBe(totalCalls.length);
		});

		it('every router.routePhoto call is wrapped in requestContext.run with userId and householdId', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const totalCalls = source.match(/\brouter\.routePhoto\s*\(/g) ?? [];

			const wrappedCalls =
				source.match(
					new RegExp(
						String.raw`requestContext\.run\s*\(\s*` +
							hasBothKeys +
							String.raw`\s*,\s*\(\s*\)\s*=>\s*router\.routePhoto\s*\(`,
						'g',
					),
				) ?? [];

			expect(totalCalls.length).toBeGreaterThan(0);
			expect(wrappedCalls.length).toBe(totalCalls.length);
		});

		it('the verification-callback dispatch block is wrapped in requestContext.run with userId and householdId', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const rvBranch = source.match(
				new RegExp(
					String.raw`resolveCallback[\s\S]{0,700}requestContext\.run\s*\(\s*` + hasBothKeys,
				),
			);
			expect(rvBranch).not.toBeNull();
		});

		it('the onboard-callback dispatch is wrapped in requestContext.run with userId and householdId', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const onboardWrap = source.match(
				new RegExp(
					String.raw`startsWith\(['"]onboard:['"]\)[\s\S]{0,400}requestContext\.run\s*\(\s*` +
						hasBothKeys,
				),
			);
			expect(onboardWrap).not.toBeNull();
		});

		it('the app-callback dispatch (handleCallbackQuery) is wrapped in requestContext.run with userId and householdId', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const appCallbackWrap = source.match(
				new RegExp(
					String.raw`requestContext\.run\s*\(\s*` +
						hasBothKeys +
						String.raw`\s*,\s*[\s\S]{0,80}=>\s*handler\s*\(`,
				),
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

			const accessBeforeResolve = source.match(
				/isEnabled\s*\([^)]*\)[\s\S]{0,600}resolveCallback\s*\(/,
			);
			expect(accessBeforeResolve).not.toBeNull();
		});

		it('no chatbot exemption in the rv: branch access check (L4 fix)', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			const rvIdx = source.indexOf("data.startsWith('rv:')");
			expect(rvIdx).toBeGreaterThan(-1);
			const rvSection = source.slice(rvIdx, rvIdx + 1000);
			expect(rvSection).not.toMatch(/chosenAppId\s*!==\s*['"]chatbot['"]/);
		});

		it('answeredCallback flag prevents double answerCallbackQuery (M2 fix)', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));

			expect(source).toMatch(/answeredCallback\s*=\s*true/);
			expect(source).toMatch(/answerCallbackQuery\s*\(\s*\{[^}]*You no longer have access/);
			expect(source).toMatch(/if\s*\(\s*!answeredCallback\s*\)[\s\S]{0,200}answerCallbackQuery/);
		});
	});

	describe('gui/routes/context.ts', () => {
		it('defines a buildCtx helper that carries both userId and householdId', async () => {
			const source = stripComments(await readSource('gui/routes/context.ts'));

			// Match the arrow function body (content between { and }) — both userId and
			// householdId must appear, and householdId must derive from householdService.
			const buildCtxMatch = source.match(
				/buildCtx\s*=\s*\(\s*userId[^)]*\)\s*=>\s*\(\s*\{([\s\S]{0,300}?)\}\s*\)/,
			);
			expect(buildCtxMatch).not.toBeNull();
			const body = (buildCtxMatch as RegExpMatchArray)[1];
			expect(body).toMatch(/\buserId\b/);
			expect(body).toMatch(/\bhouseholdId\b/);
			expect(body).toMatch(/householdService\.getHouseholdForUser\s*\(\s*userId\s*\)/);
			// null must be coerced to undefined, not passed through as null
			expect(body).toMatch(/\?\?\s*undefined/);
		});

		it('every requestContext.run wrap uses buildCtx (or an inline object with both keys)', async () => {
			const source = stripComments(await readSource('gui/routes/context.ts'));

			const totalCalls = source.match(/\brequestContext\.run\s*\(/g) ?? [];

			// Accepts either the buildCtx(userId) helper form OR a literal inline object
			// containing both userId and householdId keys.
			const wrappedCalls =
				source.match(
					new RegExp(
						String.raw`requestContext\.run\s*\(\s*(?:buildCtx\s*\(|` + hasBothKeys + String.raw`)`,
						'g',
					),
				) ?? [];

			expect(totalCalls.length).toBe(4);
			expect(wrappedCalls.length).toBe(totalCalls.length);
		});
	});

	describe('gui/index.ts', () => {
		it('throws loudly when contextStore is present but householdService is missing', async () => {
			const source = stripComments(await readSource('gui/index.ts'));

			// The guard must appear: if (!options.householdService) throw, adjacent to contextStore check.
			// This prevents silent misconfiguration where context routes are registered without
			// per-household ALS attribution.
			const throwGuard = source.match(
				/contextStore[\s\S]{0,300}!options\.householdService[\s\S]{0,200}throw\s+new\s+Error/,
			);
			expect(throwGuard).not.toBeNull();
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
			expect(source).toMatch(/\bgetCurrentHouseholdId\s*\(/);
		});
	});

	describe('bootstrap.ts — F37: condition-eval service name', () => {
		it('uses "condition-eval" (not "condition-evaluator") to guard conditionEvaluator injection', async () => {
			const source = stripComments(await readSource('bootstrap.ts'));
			expect(source).toMatch(/declaredServices\.has\s*\(\s*['"]condition-eval['"]\s*\)/);
			expect(source).not.toMatch(/declaredServices\.has\s*\(\s*['"]condition-evaluator['"]\s*\)/);
		});
	});
});
