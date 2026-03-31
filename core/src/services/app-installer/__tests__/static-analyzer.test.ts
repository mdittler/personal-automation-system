import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeApp } from '../static-analyzer.js';

describe('Static Analyzer', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-static-analyzer-'));
		await mkdir(join(tempDir, 'src'), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// --- Standard (happy path) ---

	it('should report no violations for a clean app', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			`import type { AppModule } from '@core/types';\nexport const init: AppModule['init'] = async (s) => {};\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(1);
	});

	it('should detect a single banned import', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			`import Anthropic from '@anthropic-ai/sdk';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0]).toMatchObject({
			file: 'src/index.ts',
			line: 1,
			importName: '@anthropic-ai/sdk',
			reason: 'Apps must use CoreServices.llm for all LLM access.',
		});
	});

	it('should detect multiple violations across files', async () => {
		await writeFile(join(tempDir, 'src', 'index.ts'), `import OpenAI from 'openai';\n`);
		await writeFile(join(tempDir, 'src', 'helper.ts'), `import { exec } from 'child_process';\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(2);
		expect(result.filesScanned).toBe(2);
		const imports = result.violations.map((v) => v.importName).sort();
		expect(imports).toEqual(['child_process', 'openai']);
	});

	it('should detect all banned LLM SDK imports', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				`import Anthropic from '@anthropic-ai/sdk';`,
				`import OpenAI from 'openai';`,
				`import { GoogleGenAI } from '@google/genai';`,
				`import { Ollama } from 'ollama';`,
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(4);
		const imports = result.violations.map((v) => v.importName).sort();
		expect(imports).toEqual(['@anthropic-ai/sdk', '@google/genai', 'ollama', 'openai']);
	});

	it('should detect child_process variants', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				`import { exec } from 'child_process';`,
				`import { execFile } from 'node:child_process';`,
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(2);
		const imports = result.violations.map((v) => v.importName).sort();
		expect(imports).toEqual(['child_process', 'node:child_process']);
	});

	// --- Edge cases ---

	it('should handle an empty directory', async () => {
		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(0);
	});

	it('should handle a file with no imports', async () => {
		await writeFile(
			join(tempDir, 'src', 'utils.ts'),
			'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(1);
	});

	it('should flag import type from banned packages', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			`import type { Message } from '@anthropic-ai/sdk';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('@anthropic-ai/sdk');
	});

	it('should flag dynamic import() of banned packages', async () => {
		await writeFile(join(tempDir, 'src', 'index.ts'), `const sdk = await import('openai');\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('openai');
	});

	it('should flag require() of banned packages', async () => {
		await writeFile(join(tempDir, 'src', 'index.ts'), `const cp = require('child_process');\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('child_process');
	});

	it('should scan deeply nested files', async () => {
		const deepDir = join(tempDir, 'src', 'utils', 'helpers', 'internal');
		await mkdir(deepDir, { recursive: true });
		await writeFile(join(deepDir, 'dangerous.ts'), `import { spawn } from 'node:child_process';\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].file).toBe('src/utils/helpers/internal/dangerous.ts');
	});

	it('should match subpath imports of banned packages', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			`import { ChatCompletion } from 'openai/resources';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('openai');
	});

	it('should NOT match packages that start with a banned name but are different', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			`import { helper } from 'openai-helpers';\nimport { thing } from 'ollama-utils';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});

	it('should skip node_modules directory', async () => {
		await mkdir(join(tempDir, 'node_modules', 'some-dep'), { recursive: true });
		await writeFile(
			join(tempDir, 'node_modules', 'some-dep', 'index.ts'),
			`import Anthropic from '@anthropic-ai/sdk';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(0);
	});

	it('should skip dist directory', async () => {
		await mkdir(join(tempDir, 'dist'), { recursive: true });
		await writeFile(
			join(tempDir, 'dist', 'index.js'),
			`import Anthropic from '@anthropic-ai/sdk';\n`,
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(0);
	});

	it('should scan .js, .mts, .mjs files', async () => {
		await writeFile(join(tempDir, 'src', 'a.js'), `import { Ollama } from 'ollama';\n`);
		await writeFile(join(tempDir, 'src', 'b.mts'), `import OpenAI from 'openai';\n`);
		await writeFile(join(tempDir, 'src', 'c.mjs'), `import { exec } from 'child_process';\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(3);
		expect(result.filesScanned).toBe(3);
	});

	it('should handle a non-existent directory gracefully', async () => {
		const result = await analyzeApp(join(tempDir, 'does-not-exist'));
		expect(result.violations).toHaveLength(0);
		expect(result.filesScanned).toBe(0);
	});

	// --- Security: false positive prevention ---

	it('should NOT flag banned strings inside single-line comments', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				`// import Anthropic from '@anthropic-ai/sdk';`,
				'// We used to use openai but now use CoreServices',
				'export const x = 1;',
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});

	it('should NOT flag banned strings inside block comments', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				`/* import OpenAI from 'openai'; */`,
				`* import { exec } from 'child_process';`,
				'export const x = 1;',
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});

	it('should flag export-from statements with banned packages', async () => {
		await writeFile(join(tempDir, 'src', 'index.ts'), `export { default } from 'openai';\n`);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('openai');
	});

	it('should report correct line numbers for violations', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				`import type { AppModule } from '@core/types';`,
				'',
				'// some code here',
				`import Anthropic from '@anthropic-ai/sdk';`,
				'',
				`import { exec } from 'child_process';`,
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(2);
		expect(result.violations[0].line).toBe(4);
		expect(result.violations[1].line).toBe(6);
	});

	// -- D27: Multi-line block comment detection --

	it('does not flag imports inside multi-line block comments', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			[
				'const x = 1;',
				'/*',
				"import { exec } from 'child_process';",
				"import Anthropic from '@anthropic-ai/sdk';",
				'*/',
				'const y = 2;',
			].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});

	it('flags imports after block comment closes on same line', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			["/* comment */ import { exec } from 'child_process';"].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(1);
		expect(result.violations[0].importName).toBe('child_process');
	});

	it('handles single-line block comments without flagging enclosed imports', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			["/* import { exec } from 'child_process'; */", 'const x = 1;'].join('\n'),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});

	it('handles unclosed block comments gracefully', async () => {
		await writeFile(
			join(tempDir, 'src', 'index.ts'),
			['/*', "import { exec } from 'child_process';", '// comment continues without closing'].join(
				'\n',
			),
		);

		const result = await analyzeApp(tempDir);
		expect(result.violations).toHaveLength(0);
	});
});
