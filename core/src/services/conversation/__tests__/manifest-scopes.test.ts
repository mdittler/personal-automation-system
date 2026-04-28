import { describe, it, expect } from 'vitest';
import { CONVERSATION_DATA_SCOPES } from '../manifest.js';

describe('CONVERSATION_DATA_SCOPES', () => {
	it('includes conversation/ path with read-write access', () => {
		const entry = CONVERSATION_DATA_SCOPES.find((s) => s.path === 'conversation/');
		expect(entry).toBeDefined();
		expect(entry?.access).toBe('read-write');
	});

	it('still includes history.json', () => {
		const entry = CONVERSATION_DATA_SCOPES.find((s) => s.path === 'history.json');
		expect(entry).toBeDefined();
	});

	it('still includes daily-notes/', () => {
		const entry = CONVERSATION_DATA_SCOPES.find((s) => s.path === 'daily-notes/');
		expect(entry).toBeDefined();
	});
});
