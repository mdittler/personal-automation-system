/**
 * Parity test: CONVERSATION_DATA_SCOPES in manifest.ts must mirror
 * apps/chatbot/manifest.yaml requirements.data.user_scopes exactly.
 *
 * This test catches drift before Chunk B starts loading from the constants
 * instead of parsing the YAML.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONVERSATION_DATA_SCOPES } from '../manifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHATBOT_MANIFEST_PATH = resolve(
	__dirname,
	'../../../../../apps/chatbot/manifest.yaml',
);

describe('CONVERSATION_DATA_SCOPES parity with apps/chatbot/manifest.yaml', () => {
	it('matches requirements.data.user_scopes path, access, and description exactly', async () => {
		const raw = await readFile(CHATBOT_MANIFEST_PATH, 'utf-8');
		const manifest = parse(raw) as {
			requirements?: { data?: { user_scopes?: Array<{ path: string; access: string; description: string }> } };
		};
		const yamlScopes = manifest.requirements?.data?.user_scopes ?? [];

		expect(CONVERSATION_DATA_SCOPES).toHaveLength(yamlScopes.length);

		for (let i = 0; i < yamlScopes.length; i++) {
			expect(CONVERSATION_DATA_SCOPES[i].path).toBe(yamlScopes[i].path);
			expect(CONVERSATION_DATA_SCOPES[i].access).toBe(yamlScopes[i].access);
			expect(CONVERSATION_DATA_SCOPES[i].description).toBe(yamlScopes[i].description);
		}
	});
});
