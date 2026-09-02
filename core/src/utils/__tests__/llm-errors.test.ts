import { describe, expect, it } from 'vitest';
import { classifyLLMError, isParameterRejectionError } from '../llm-errors.js';

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

		it('should classify PAS LLMRateLimitError by name (app scope)', () => {
			const error = new Error('Rate limited');
			error.name = 'LLMRateLimitError';
			const info = classifyLLMError(error);
			expect(info.category).toBe('rate-limit');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify LLMRateLimitError with scope:household as household-rate-limit', () => {
			const error = Object.assign(new Error('Household rate limit'), {
				name: 'LLMRateLimitError',
				scope: 'household',
			});
			const info = classifyLLMError(error);
			expect(info.category).toBe('household-rate-limit');
			expect(info.isRetryable).toBe(true);
			expect(info.userMessage).toContain('household');
		});

		it('should classify LLMRateLimitError with scope:reservation-exceeded as reservation-exceeded', () => {
			const error = Object.assign(new Error('Reservation exceeded'), {
				name: 'LLMRateLimitError',
				scope: 'reservation-exceeded',
			});
			const info = classifyLLMError(error);
			expect(info.category).toBe('reservation-exceeded');
			expect(info.isRetryable).toBe(true);
			expect(info.userMessage).toContain('try again');
		});

		it('should classify PAS LLMCostCapError by name (app scope)', () => {
			const error = new Error('Cost cap exceeded');
			error.name = 'LLMCostCapError';
			const info = classifyLLMError(error);
			expect(info.category).toBe('cost-cap');
			expect(info.isRetryable).toBe(false);
			expect(info.userMessage).toContain('usage limit');
		});

		it('should classify LLMCostCapError with scope:household as household-cost-cap', () => {
			const error = Object.assign(new Error('Household cost cap'), {
				name: 'LLMCostCapError',
				scope: 'household',
			});
			const info = classifyLLMError(error);
			expect(info.category).toBe('household-cost-cap');
			expect(info.isRetryable).toBe(false);
			expect(info.userMessage).toContain('household');
		});

		it('should classify LLMCostCapError with scope:reservation-exceeded as reservation-exceeded', () => {
			const error = Object.assign(new Error('Reservation exceeded'), {
				name: 'LLMCostCapError',
				scope: 'reservation-exceeded',
			});
			const info = classifyLLMError(error);
			expect(info.category).toBe('reservation-exceeded');
			expect(info.isRetryable).toBe(true);
		});

		it('should classify generic Error as unknown', () => {
			const error = new Error('Something went wrong');
			const info = classifyLLMError(error);
			expect(info.category).toBe('unknown');
			expect(info.isRetryable).toBe(true);
		});
	});

	describe('parameter rejection', () => {
		it('classifies the observed Anthropic temperature deprecation as parameter-rejection', () => {
			const error = {
				status: 400,
				message: '`temperature` is deprecated for this model.',
			};
			const info = classifyLLMError(error);
			expect(info.category).toBe('parameter-rejection');
		});

		it('is NOT retryable — the same request fails identically every time', () => {
			const error = { status: 400, message: '`temperature` is deprecated for this model.' };
			expect(classifyLLMError(error).isRetryable).toBe(false);
		});

		it('states the real reason rather than telling the user to try again later', () => {
			const error = { status: 400, message: '`temperature` is deprecated for this model.' };
			const { userMessage } = classifyLLMError(error);
			expect(userMessage).toContain('rejected');
			expect(userMessage).not.toContain('try again later');
		});

		it.each([
			['Unsupported parameter: ‘temperature’ is not supported with this model.'],
			['Unrecognized request argument supplied: temperature'],
			['Invalid JSON payload received. Unknown name "temperature".'],
			['temperature: Extra inputs are not permitted'],
		])('classifies provider phrasing %#: %s', (message) => {
			expect(classifyLLMError({ status: 400, message }).category).toBe('parameter-rejection');
		});

		it('only applies to status 400 — the same wording on a 500 stays overloaded', () => {
			const error = { status: 500, message: '`temperature` is deprecated for this model.' };
			expect(classifyLLMError(error).category).toBe('overloaded');
		});

		it('does not hijack the billing 400, which is checked first', () => {
			const error = {
				status: 400,
				message: 'Your credit balance is too low; unknown parameter checks come later.',
			};
			expect(classifyLLMError(error).category).toBe('billing');
		});

		it('isParameterRejectionError is true for a parameter 400 and false otherwise', () => {
			expect(
				isParameterRejectionError({
					status: 400,
					message: '`temperature` is deprecated for this model.',
				}),
			).toBe(true);
			expect(isParameterRejectionError({ status: 400, message: 'Invalid request format' })).toBe(
				false,
			);
			expect(isParameterRejectionError(new Error('boom'))).toBe(false);
			expect(isParameterRejectionError(null)).toBe(false);
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
