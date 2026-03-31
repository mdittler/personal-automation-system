import { describe, expect, it } from 'vitest';
import { classifyLLMError } from '../llm-errors.js';

describe('classifyLLMError', () => {
	describe('standard', () => {
		it('should classify billing error (status 400 + credit message)', () => {
			const error = {
				status: 400,
				message: 'Your credit balance is too low to access the Anthropic API.',
			};
			const info = classifyLLMError(error);
			expect(info.category).toBe('billing');
			expect(info.isRetryable).toBe(false);
			expect(info.userMessage).toContain('credits are too low');
		});

		it('should classify billing error (status 400 + billing message)', () => {
			const error = { status: 400, message: 'Billing issue detected' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('billing');
		});

		it('should classify provider rate limit (status 429)', () => {
			const error = { status: 429, message: 'Rate limit exceeded' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('rate-limit');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify auth error (status 401)', () => {
			const error = { status: 401, message: 'Invalid API key' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('auth');
			expect(info.isRetryable).toBe(false);
			expect(info.userMessage).toContain('configuration error');
		});

		it('should classify server error (status 500)', () => {
			const error = { status: 500, message: 'Internal server error' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('overloaded');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify overloaded (status 529)', () => {
			const error = { status: 529, message: 'Overloaded' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('overloaded');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify PAS LLMRateLimitError by name', () => {
			const error = new Error('Rate limited');
			error.name = 'LLMRateLimitError';
			const info = classifyLLMError(error);
			expect(info.category).toBe('rate-limit');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify PAS LLMCostCapError by name', () => {
			const error = new Error('Cost cap exceeded');
			error.name = 'LLMCostCapError';
			const info = classifyLLMError(error);
			expect(info.category).toBe('cost-cap');
			expect(info.isRetryable).toBe(false);
			expect(info.userMessage).toContain('usage limit');
		});

		it('should classify generic Error as unknown', () => {
			const error = new Error('Something went wrong');
			const info = classifyLLMError(error);
			expect(info.category).toBe('unknown');
			expect(info.isRetryable).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('should classify status 400 without credit/billing keywords as unknown', () => {
			const error = { status: 400, message: 'Invalid request format' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('unknown');
		});

		it('should classify error with no status or name as unknown', () => {
			const error = { foo: 'bar' };
			const info = classifyLLMError(error);
			expect(info.category).toBe('unknown');
		});

		it('should classify non-Error thrown value (string) as unknown', () => {
			const info = classifyLLMError('something broke');
			expect(info.category).toBe('unknown');
		});

		it('should classify null error as unknown', () => {
			const info = classifyLLMError(null);
			expect(info.category).toBe('unknown');
		});

		it('should classify undefined error as unknown', () => {
			const info = classifyLLMError(undefined);
			expect(info.category).toBe('unknown');
		});
	});
});
