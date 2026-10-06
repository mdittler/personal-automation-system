import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('tsx resolves @pas/core/* to core source (REQ-REG-024 harness; review C21)', () => {
	it('the probe prints a core/src path, never core/dist', async () => {
		const { stdout } = await execFileAsync(
			process.execPath,
			['--import=tsx/esm', join(process.cwd(), 'src', '__tests__', '_tsx-resolve-probe.ts')],
			{
				cwd: join(process.cwd(), '..'),
				env: { ...process.env, TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json') },
			},
		);
		expect(stdout.trim()).toMatch(/\/core\/src\/utils\/json-strip-fences\.ts$/);
		expect(stdout).not.toContain('/core/dist/');
	}, 20_000);
});
