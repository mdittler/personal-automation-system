import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REGRESSION_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('tsx resolves @pas/core/* to core source (REQ-REG-024 harness; review C21)', () => {
	it('the probe prints a core/src path, never core/dist', async () => {
		const { stdout } = await execFileAsync(
			process.execPath,
			['--import=tsx/esm', join(HERE, '_tsx-resolve-probe.ts')],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, TSX_TSCONFIG_PATH: join(REGRESSION_ROOT, 'tsconfig.json') },
			},
		);
		expect(stdout.trim()).toMatch(/\/core\/src\/utils\/json-strip-fences\.ts$/);
		expect(stdout).not.toContain('/core/dist/');
	}, 20_000);
});
