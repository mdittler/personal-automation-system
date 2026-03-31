/**
 * YAML utilities.
 *
 * Thin wrappers around the `yaml` package for reading and writing YAML.
 */

import { readFile, stat } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { atomicWrite } from './file.js';

/**
 * Parse a YAML string into an object.
 */
export function parseYaml<T = unknown>(content: string): T {
	return parse(content) as T;
}

/**
 * Serialize an object to a YAML string.
 */
export function toYaml(data: unknown): string {
	return stringify(data);
}

/**
 * Read and parse a YAML file. Returns null if the file doesn't exist.
 */
export async function readYamlFile<T = unknown>(filePath: string): Promise<T | null> {
	try {
		const exists = await stat(filePath)
			.then((s) => s.isFile())
			.catch(() => false);
		if (!exists) return null;

		const content = await readFile(filePath, 'utf-8');
		return parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Write an object as YAML to a file (atomic write).
 */
export async function writeYamlFile(filePath: string, data: unknown): Promise<void> {
	const content = stringify(data);
	await atomicWrite(filePath, content);
}
