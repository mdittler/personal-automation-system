import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import { validateAlert } from '../alert-validator.js';

const logger = pino({ level: 'silent' });

const mockUserManager = {
	isRegistered: (id: string) => ['user1', 'user2'].includes(id),
	getAllUsers: () => [
		{ id: 'user1', name: 'Alice' },
		{ id: 'user2', name: 'Bob' },
	],
} as any;

function makeValidAlert(actionOverride: any): AlertDefinition {
	return {
		id: 'test-alert',
		name: 'Test Alert',
		enabled: true,
		schedule: '0 9 * * *',
		condition: {
			type: 'deterministic',
			expression: 'not empty',
			data_sources: [{ app_id: 'notes', user_id: 'user1', path: 'test.md' }],
		},
		actions: [actionOverride],
		delivery: ['user1'],
		cooldown: '1 hour',
	};
}

// --- webhook validation ---

describe('validateAlert — webhook action', () => {
	it('accepts valid webhook config', () => {
		const def = makeValidAlert({
			type: 'webhook',
			config: { url: 'https://example.com/hook' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});

	it('rejects missing URL', () => {
		const def = makeValidAlert({ type: 'webhook', config: { url: '' } });
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('url'))).toBe(true);
	});

	it('rejects non-http URL', () => {
		const def = makeValidAlert({
			type: 'webhook',
			config: { url: 'ftp://example.com' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('http'))).toBe(true);
	});

	it('rejects file:// URL', () => {
		const def = makeValidAlert({
			type: 'webhook',
			config: { url: 'file:///etc/passwd' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('http'))).toBe(true);
	});

	it('rejects javascript: URL', () => {
		const def = makeValidAlert({
			type: 'webhook',
			config: { url: 'javascript:alert(1)' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('http'))).toBe(true);
	});

	it('accepts http URL', () => {
		const def = makeValidAlert({
			type: 'webhook',
			config: { url: 'http://internal-server:8080/hook' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});
});

// --- write_data validation ---

describe('validateAlert — write_data action', () => {
	it('accepts valid write_data config', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: {
				app_id: 'notes',
				user_id: 'user1',
				path: 'log.md',
				content: 'Alert: {alert_name}',
				mode: 'append',
			},
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});

	it('rejects missing app_id', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: '', user_id: 'user1', path: 'log.md', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('app_id'))).toBe(true);
	});

	it('rejects invalid app_id format', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'INVALID', user_id: 'user1', path: 'log.md', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('app_id'))).toBe(true);
	});

	it('rejects missing user_id', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: '', path: 'log.md', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(true);
	});

	it('rejects unregistered user_id', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'unknown', path: 'log.md', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('not a registered'))).toBe(true);
	});

	it('rejects missing path', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: '', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('path'))).toBe(true);
	});

	it('rejects path traversal', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: '../etc/passwd', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('..'))).toBe(true);
	});

	it('rejects absolute path', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: '/etc/passwd', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('relative'))).toBe(true);
	});

	it('rejects invalid mode', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: 'log.md', content: 'x', mode: 'delete' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('mode'))).toBe(true);
	});

	it('rejects backslash in path', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: 'sub\\dir\\file.md', content: 'x', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('forward slashes'))).toBe(true);
	});

	it('accepts empty string content (valid for append)', () => {
		const def = makeValidAlert({
			type: 'write_data',
			config: { app_id: 'notes', user_id: 'user1', path: 'log.md', content: '', mode: 'append' },
		});
		const errors = validateAlert(def, mockUserManager);
		// No content-related error
		expect(errors.some((e) => e.field.includes('content'))).toBe(false);
	});
});

// --- audio validation ---

describe('validateAlert — audio action', () => {
	it('accepts valid audio config', () => {
		const def = makeValidAlert({
			type: 'audio',
			config: { message: 'Alert: {alert_name}' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});

	it('accepts audio config with device', () => {
		const def = makeValidAlert({
			type: 'audio',
			config: { message: 'Alert!', device: 'Kitchen' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});

	it('rejects empty message', () => {
		const def = makeValidAlert({ type: 'audio', config: { message: '' } });
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('message'))).toBe(true);
	});

	it('rejects whitespace-only message', () => {
		const def = makeValidAlert({ type: 'audio', config: { message: '   ' } });
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('message'))).toBe(true);
	});
});

// --- dispatch_message validation ---

describe('validateAlert — dispatch_message action', () => {
	it('accepts valid dispatch_message config', () => {
		const def = makeValidAlert({
			type: 'dispatch_message',
			config: { text: '/note {summary}', user_id: 'user1' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors).toEqual([]);
	});

	it('rejects empty text', () => {
		const def = makeValidAlert({
			type: 'dispatch_message',
			config: { text: '', user_id: 'user1' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('text'))).toBe(true);
	});

	it('rejects missing user_id', () => {
		const def = makeValidAlert({
			type: 'dispatch_message',
			config: { text: 'hello', user_id: '' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.field.includes('user_id'))).toBe(true);
	});

	it('rejects unregistered user_id', () => {
		const def = makeValidAlert({
			type: 'dispatch_message',
			config: { text: 'hello', user_id: 'unknown-user' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('not a registered'))).toBe(true);
	});

	it('rejects invalid user_id format', () => {
		const def = makeValidAlert({
			type: 'dispatch_message',
			config: { text: 'hello', user_id: '../evil' },
		});
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('invalid characters'))).toBe(true);
	});
});

// --- All action types recognized ---

describe('validateAlert — action type recognition', () => {
	for (const type of ['telegram_message', 'run_report', 'webhook', 'write_data', 'audio', 'dispatch_message']) {
		it(`recognizes "${type}" as a valid action type`, () => {
			// Use minimal config — we're testing type recognition, not config validation
			const def = makeValidAlert({ type, config: {} });
			const errors = validateAlert(def, mockUserManager);
			// Should not have "invalid action type" error
			expect(errors.some((e) => e.message.includes('Invalid action type'))).toBe(false);
		});
	}

	it('rejects unknown action type', () => {
		const def = makeValidAlert({ type: 'email', config: {} });
		const errors = validateAlert(def, mockUserManager);
		expect(errors.some((e) => e.message.includes('Invalid action type'))).toBe(true);
	});
});
