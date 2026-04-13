/**
 * Smoke test: every script entry in the root package.json that points to a
 * .ts or .js file must resolve to a file that actually exists on disk.
 *
 * This prevents dead-script references like the removed `register-app` from
 * silently remaining in package.json after the implementation file is deleted.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve path to repo root package.json (5 levels up from __tests__/)
// core/src/cli/__tests__ → core/src/cli → core/src → core → repo root
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

describe('root package.json scripts smoke test', () => {
	it('every script that references a .ts/.js file must point to an existing file', async () => {
		const pkgPath = join(repoRoot, 'package.json');
		const raw = await readFile(pkgPath, 'utf-8');
		const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };

		const scripts = pkg.scripts ?? {};
		const broken: string[] = [];

		for (const [name, cmd] of Object.entries(scripts)) {
			// Extract the file argument from commands like "tsx core/src/cli/foo.ts"
			// or "node scripts/bar.js"
			const match = cmd.match(/(?:tsx\s+|node\s+)(\S+\.(?:ts|js))/);
			if (!match) continue;

			const relPath = match[1];
			const absPath = resolve(repoRoot, relPath);
			if (!existsSync(absPath)) {
				broken.push(`"${name}": "${cmd}" — file not found: ${relPath}`);
			}
		}

		if (broken.length > 0) {
			throw new Error(
				`The following package.json scripts reference files that do not exist:\n  ${broken.join('\n  ')}`,
			);
		}
	});

	it('register-app script is not present in package.json', async () => {
		const pkgPath = join(repoRoot, 'package.json');
		const raw = await readFile(pkgPath, 'utf-8');
		const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
		expect(pkg.scripts).not.toHaveProperty('register-app');
	});
});
