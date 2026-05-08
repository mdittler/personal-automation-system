/**
 * Shared atomic mutator for pas.yaml.
 *
 * Single chokepoint for all runtime mutations of pas.yaml. Both
 * syncUsersToConfig and SystemConfigWriter route through here so concurrent
 * writers (users-array sync vs system-key write) serialise against the same
 * file lock and cannot interleave.
 *
 * Missing pas.yaml is a hard error — PAS always has a loaded config at
 * runtime; absence at write time indicates corruption, not a fresh install.
 */
import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { withFileLock } from '../../utils/file-mutex.js';
import { atomicWrite } from '../../utils/file.js';

/**
 * Read → apply mutator → write pas.yaml atomically under a file lock.
 *
 * The mutator receives the fully parsed YAML object and must return the
 * object to write back. All other top-level keys are preserved
 * parse-equivalently (re-serialisation may reformat, but parse(output)
 * deep-equals parse(original) for every unmodified key).
 *
 * Throws if:
 *  - configPath does not exist (ENOENT → descriptive Error)
 *  - the file cannot be read or written (propagates OS error)
 *  - the mutator throws (file is left unchanged)
 */
export async function mutatePasYaml(
	configPath: string,
	mutator: (parsed: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
	await withFileLock(configPath, async () => {
		let rawText: string;
		try {
			rawText = await readFile(configPath, 'utf-8');
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(
					`mutatePasYaml: config file not found at '${configPath}'. PAS requires an existing pas.yaml at runtime.`,
				);
			}
			throw err;
		}

		const parsed: Record<string, unknown> =
			(rawText ? (parse(rawText) as Record<string, unknown>) : null) ?? {};

		const updated = mutator(parsed);
		const output = stringify(updated);
		await atomicWrite(configPath, output);
	});
}
