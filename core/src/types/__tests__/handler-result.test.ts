/**
 * Compile-time regression for HandlerResult + AppModule['handleMessage'] compatibility.
 *
 * If this file compiles and vitest reports 0 failures, the type contract is satisfied:
 * both legacy void handlers and explicit {handled:boolean} handlers fit the AppModule shape.
 */
import { describe, expect, it } from 'vitest';
import type { AppModule } from '../app-module.js';
import type { HandlerResult } from '../handler-result.js';

describe('HandlerResult type', () => {
	it('accepts void (legacy handler pattern)', () => {
		const handler: AppModule['handleMessage'] = async (_ctx) => {
			// void return — legacy apps never return a value
		};
		expect(typeof handler).toBe('function');
	});

	it('accepts {handled: false} (yield-to-chatbot pattern)', () => {
		const handler: AppModule['handleMessage'] = async (_ctx) => {
			return { handled: false };
		};
		expect(typeof handler).toBe('function');
	});

	it('accepts {handled: true} (explicit handled pattern)', () => {
		const handler: AppModule['handleMessage'] = async (_ctx) => {
			return { handled: true };
		};
		expect(typeof handler).toBe('function');
	});

	it('HandlerResult includes void in its union', () => {
		const result: HandlerResult = undefined;
		expect(result).toBeUndefined();
	});
});
