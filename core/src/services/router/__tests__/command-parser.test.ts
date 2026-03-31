import { describe, expect, it } from 'vitest';
import type { CommandMapEntry } from '../../app-registry/manifest-cache.js';
import { lookupCommand, parseCommand } from '../command-parser.js';

describe('parseCommand', () => {
	it('should parse a command with arguments', () => {
		const result = parseCommand('/echo hello world');
		expect(result).toEqual({
			command: '/echo',
			args: ['hello', 'world'],
			rawArgs: 'hello world',
		});
	});

	it('should parse a command with no arguments', () => {
		const result = parseCommand('/help');
		expect(result).toEqual({
			command: '/help',
			args: [],
			rawArgs: '',
		});
	});

	it('should strip @botname suffix', () => {
		const result = parseCommand('/echo@my_bot hello');
		expect(result).toEqual({
			command: '/echo',
			args: ['hello'],
			rawArgs: 'hello',
		});
	});

	it('should strip @botname with no arguments', () => {
		const result = parseCommand('/help@my_bot');
		expect(result).toEqual({
			command: '/help',
			args: [],
			rawArgs: '',
		});
	});

	it('should return null for non-command text', () => {
		expect(parseCommand('hello world')).toBeNull();
		expect(parseCommand('add milk to the list')).toBeNull();
	});

	it('should return null for just a slash', () => {
		expect(parseCommand('/')).toBeNull();
	});

	it('should return null for slash with only space', () => {
		expect(parseCommand('/ ')).toBeNull();
	});

	it('should handle extra whitespace in arguments', () => {
		const result = parseCommand('/echo   hello   world  ');
		expect(result).toEqual({
			command: '/echo',
			args: ['hello', 'world'],
			rawArgs: '  hello   world',
		});
	});

	it('should handle leading/trailing whitespace', () => {
		const result = parseCommand('  /echo hello  ');
		expect(result).toEqual({
			command: '/echo',
			args: ['hello'],
			rawArgs: 'hello',
		});
	});

	it('should preserve rawArgs exactly', () => {
		const result = parseCommand('/add milk, eggs, and bread');
		expect(result).toEqual({
			command: '/add',
			args: ['milk,', 'eggs,', 'and', 'bread'],
			rawArgs: 'milk, eggs, and bread',
		});
	});
});

describe('lookupCommand', () => {
	const commandMap = new Map<string, CommandMapEntry>([
		[
			'/echo',
			{
				appId: 'echo',
				command: { name: '/echo', description: 'Echo a message', args: ['message'] },
			},
		],
		[
			'/grocery',
			{
				appId: 'grocery',
				command: { name: '/grocery', description: 'Manage grocery list' },
			},
		],
	]);

	it('should find a registered command', () => {
		// biome-ignore lint/style/noNonNullAssertion: known valid command
		const parsed = parseCommand('/echo hello')!;
		const result = lookupCommand(parsed, commandMap);

		expect(result).toEqual({
			appId: 'echo',
			command: { name: '/echo', description: 'Echo a message', args: ['message'] },
			parsedArgs: ['hello'],
			rawArgs: 'hello',
		});
	});

	it('should return null for an unregistered command', () => {
		// biome-ignore lint/style/noNonNullAssertion: known valid command format
		const parsed = parseCommand('/unknown test')!;
		const result = lookupCommand(parsed, commandMap);

		expect(result).toBeNull();
	});
});
