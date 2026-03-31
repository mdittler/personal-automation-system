import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseYaml, readYamlFile, toYaml, writeYamlFile } from '../yaml.js';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-yaml-test-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('parseYaml', () => {
	it('parses YAML string to object', () => {
		const yaml = 'name: test\nvalue: 42\n';
		const result = parseYaml<{ name: string; value: number }>(yaml);
		expect(result).toEqual({ name: 'test', value: 42 });
	});

	it('handles empty string', () => {
		const result = parseYaml('');
		expect(result).toBeNull();
	});
});

describe('toYaml', () => {
	it('serializes object to YAML string', () => {
		const data = { name: 'test', value: 42 };
		const result = toYaml(data);
		expect(result).toContain('name: test');
		expect(result).toContain('value: 42');
	});
});

describe('writeYamlFile', () => {
	it('creates file on disk', async () => {
		const filePath = join(tempDir, 'output.yaml');
		await writeYamlFile(filePath, { key: 'value' });
		expect(existsSync(filePath)).toBe(true);
	});
});

describe('readYamlFile', () => {
	it('reads a written YAML file', async () => {
		const filePath = join(tempDir, 'data.yaml');
		await writeYamlFile(filePath, { items: [1, 2, 3] });

		const result = await readYamlFile<{ items: number[] }>(filePath);
		expect(result).toEqual({ items: [1, 2, 3] });
	});

	it('returns null for non-existent file', async () => {
		const result = await readYamlFile(join(tempDir, 'missing.yaml'));
		expect(result).toBeNull();
	});

	it('returns null for directory path', async () => {
		const dirPath = join(tempDir, 'a-directory');
		await mkdir(dirPath);
		const result = await readYamlFile(dirPath);
		expect(result).toBeNull();
	});
});

describe('roundtrip', () => {
	it('writeYamlFile then readYamlFile returns original data', async () => {
		const filePath = join(tempDir, 'roundtrip.yaml');
		const original = {
			name: 'roundtrip-test',
			nested: { a: 1, b: 'two' },
			list: ['x', 'y', 'z'],
		};

		await writeYamlFile(filePath, original);
		const result = await readYamlFile(filePath);
		expect(result).toEqual(original);
	});
});
