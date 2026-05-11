import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCases } from '../runner/case-loader.js';

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'reg-loader-'));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const validCaseModule = (id: string) => `
import type { PersonaCase } from '${join(process.cwd(), 'regression/src/shared/types.ts').replace(/'/g, "\\'")}';
const c: PersonaCase = {
  id: '${id}',
  description: 't',
  bucket: 'routing',
  routingTarget: 'food-shadow',
  coverage: ['regression/src/runner/case-loader.ts'],
  inputs: [{
    payload: 'hi',
    expected: { schema: { type: 'object' }, strings: [{ path: 'action', expectedCaseInsensitive: 'none' }] },
  }],
  oracle: 'structural',
  budgetUsd: 0.01,
};
export default c;
`;

const indexModule = (ids: string[]) => `
import type { LoadedCase, PersonaCase } from '${join(process.cwd(), 'regression/src/shared/types.ts').replace(/'/g, "\\'")}';
import { fileURLToPath } from 'node:url';
const HERE = fileURLToPath(import.meta.url);
export function buildCases(): LoadedCase[] {
  return ${JSON.stringify(ids)}.map((id) => {
    const c: PersonaCase = {
      id,
      description: 't',
      bucket: 'routing',
      routingTarget: 'food-shadow',
      coverage: ['regression/src/runner/case-loader.ts'],
      inputs: [{
        payload: 'hi',
        expected: { schema: { type: 'object' }, strings: [{ path: 'action', expectedCaseInsensitive: 'none' }] },
      }],
      oracle: 'structural',
      budgetUsd: 0.01,
    };
    return { case: c, filePath: HERE };
  });
}
`;

describe('loadCases', () => {
	it('loads .case.ts files (default export)', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'a.case.ts'), validCaseModule('case-a'));
		const cases = await loadCases(join(root, 'cases'));
		expect(cases).toHaveLength(1);
		expect(cases[0]!.case.id).toBe('case-a');
		expect(cases[0]!.filePath.endsWith('a.case.ts')).toBe(true);
	});

	it('loads index.ts modules exporting buildCases()', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'index.ts'), indexModule(['x-id', 'y-id', 'z-id']));
		const cases = await loadCases(join(root, 'cases'));
		expect(cases.map((c) => c.case.id)).toEqual(['x-id', 'y-id', 'z-id']);
	});

	it('returns cases sorted by id', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'z.case.ts'), validCaseModule('z-id'));
		await writeFile(join(root, 'cases', 'a.case.ts'), validCaseModule('a-id'));
		const cases = await loadCases(join(root, 'cases'));
		expect(cases.map((c) => c.case.id)).toEqual(['a-id', 'z-id']);
	});

	it('throws on duplicate ids across .case.ts files', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'a.case.ts'), validCaseModule('dupe-id'));
		await writeFile(join(root, 'cases', 'b.case.ts'), validCaseModule('dupe-id'));
		await expect(loadCases(join(root, 'cases'))).rejects.toThrow(/duplicate.*dupe-id/i);
	});

	it('throws on duplicate ids across .case.ts + index.ts', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'a.case.ts'), validCaseModule('shared-id'));
		await writeFile(join(root, 'cases', 'index.ts'), indexModule(['shared-id']));
		await expect(loadCases(join(root, 'cases'))).rejects.toThrow(/duplicate.*shared-id/i);
	});

	it('throws when .case.ts has no default export', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'a.case.ts'), `export const x = 1;`);
		await expect(loadCases(join(root, 'cases'))).rejects.toThrow(/default export/i);
	});

	it('throws when index.ts does not export buildCases()', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'index.ts'), `export const x = 1;`);
		await expect(loadCases(join(root, 'cases'))).rejects.toThrow(/buildCases/i);
	});

	it('runs validatePersonaCase on each loaded case', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(
			join(root, 'cases', 'a.case.ts'),
			`const c = { id: 'BAD ID', bucket: 'routing' };
       export default c;`,
		);
		await expect(loadCases(join(root, 'cases'))).rejects.toThrow();
	});

	it('ignores non-.case.ts files (except index.ts)', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		await writeFile(join(root, 'cases', 'helper.ts'), 'export const x = 1;');
		await writeFile(join(root, 'cases', 'README.md'), '# nothing');
		const cases = await loadCases(join(root, 'cases'));
		expect(cases).toHaveLength(0);
	});

	it('recurses into subdirectories', async () => {
		await mkdir(join(root, 'cases', 'sub'), { recursive: true });
		await writeFile(join(root, 'cases', 'sub', 'a.case.ts'), validCaseModule('nested-a'));
		await writeFile(join(root, 'cases', 'sub', 'b.case.ts'), validCaseModule('nested-b'));
		const cases = await loadCases(join(root, 'cases'));
		expect(cases.map((c) => c.case.id).sort()).toEqual(['nested-a', 'nested-b']);
	});

	it('returns empty array for a directory with no eligible files', async () => {
		await mkdir(join(root, 'cases'), { recursive: true });
		const cases = await loadCases(join(root, 'cases'));
		expect(cases).toEqual([]);
	});
});
