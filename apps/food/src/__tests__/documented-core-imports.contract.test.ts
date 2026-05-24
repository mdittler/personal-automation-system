/**
 * Documented public-API smoke test — Codex Round 2 finding 5.
 *
 * Why: `docs/CREATING_AN_APP.md` tells app authors to import
 * `toAppMessageKind` from `@pas/core/services/app-outbound-bridge` when
 * slugging a user-supplied name into an app message `kind`. That subpath
 * is declared in `core/package.json` `exports`, but without an end-to-end
 * test from an app workspace, a future refactor that removes the export
 * (or renames the helper) would silently break the documented guidance —
 * the broken `import` lives in the docs, not in any test.
 *
 * This test exercises the documented import path from a real app workspace
 * and asserts the helper behaves as documented. If somebody removes the
 * `./services/app-outbound-bridge` subpath, deletes the helper, or changes
 * its slugging contract, this test fails immediately — and the documentation
 * page that promises the import is the place to look.
 */

import { toAppMessageKind } from '@pas/core/services/app-outbound-bridge';
import { describe, expect, test } from 'vitest';

describe('documented core import — @pas/core/services/app-outbound-bridge', () => {
	test('toAppMessageKind is callable through the documented subpath', () => {
		// Mirrors the docs example (CREATING_AN_APP.md ~L468): the helper
		// slugifies a user-supplied alert title so invalid characters do not
		// silently fail manifest kind validation.
		expect(toAppMessageKind('Expiry Warning!')).toBe('expiry-warning');
	});
});
