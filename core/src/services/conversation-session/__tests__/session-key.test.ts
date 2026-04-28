import { describe, it, expect } from 'vitest';
import { buildSessionKey } from '../session-key.js';
import { InvalidSessionKeyError } from '../errors.js';

describe('buildSessionKey', () => {
	it('builds canonical telegram dm key', () => {
		expect(buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: 'matt' })).toBe(
			'agent:main:telegram:dm:matt',
		);
	});

	it('supports group scope (builder only — dispatch never sets group in P3)', () => {
		expect(buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'group', chatId: 'fam-7' })).toBe(
			'agent:main:telegram:group:fam-7',
		);
	});

	it('rejects chatId containing ":"', () => {
		expect(() => buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: 'a:b' })).toThrow(
			InvalidSessionKeyError,
		);
	});

	it('rejects chatId containing ".."', () => {
		expect(() => buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: '../etc' })).toThrow(
			InvalidSessionKeyError,
		);
	});

	it('rejects chatId containing forward slash', () => {
		expect(() => buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: 'a/b' })).toThrow(
			InvalidSessionKeyError,
		);
	});

	it('rejects chatId containing backslash', () => {
		expect(() => buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: 'a\\b' })).toThrow(
			InvalidSessionKeyError,
		);
	});

	it('rejects empty chatId', () => {
		expect(() => buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: '' })).toThrow(
			InvalidSessionKeyError,
		);
	});

	it('accepts chatId with hyphens and underscores', () => {
		expect(buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: 'user-123_abc' })).toBe(
			'agent:main:telegram:dm:user-123_abc',
		);
	});
});
