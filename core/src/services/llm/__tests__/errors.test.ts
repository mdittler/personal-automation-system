import { describe, it, expect } from 'vitest';
import { LLMCostCapError, LLMRateLimitError } from '../errors.js';

describe('LLMCostCapError', () => {
    it('instanceof LLMCostCapError and Error', () => {
        const e = new LLMCostCapError({ scope: 'household', householdId: 'h1', currentCost: 20, cap: 20 });
        expect(e).toBeInstanceOf(LLMCostCapError);
        expect(e).toBeInstanceOf(Error);
    });

    it('exposes scope field for each of the four union members', () => {
        const scopes = ['app', 'global', 'household', 'reservation-exceeded'] as const;
        for (const s of scopes) {
            const e = new LLMCostCapError({ scope: s, currentCost: 1, cap: 2 } as any);
            expect(e.scope).toBe(s);
        }
    });

    it('household scope message includes householdId and cap number', () => {
        const e = new LLMCostCapError({ scope: 'household', householdId: 'h1', currentCost: 20.01, cap: 20 });
        expect(e.message).toContain('h1');
        expect(e.message).toContain('20');
    });

    it('reservation-exceeded scope exposes reservationId', () => {
        const e = new LLMCostCapError({ scope: 'reservation-exceeded', reservationId: 'r1', currentCost: 25, cap: 20 });
        expect(e.scope).toBe('reservation-exceeded');
        expect((e as any).reservationId).toBe('r1');
    });

    it('app scope preserves backward-compat — appId in message', () => {
        const e = new LLMCostCapError({ scope: 'app', appId: 'chatbot', currentCost: 5, cap: 10 });
        expect(e.scope).toBe('app');
        expect(e.message).toContain('chatbot');
    });

    it('global scope message says Global', () => {
        const e = new LLMCostCapError({ scope: 'global', currentCost: 51, cap: 50 });
        expect(e.message.toLowerCase()).toContain('global');
    });
});

describe('LLMRateLimitError', () => {
    it('app scope preserves backward-compat default', () => {
        const e = new LLMRateLimitError({ appId: 'chatbot', maxRequests: 60, windowSeconds: 3600 });
        expect(e.scope).toBe('app');
        expect(e.appId).toBe('chatbot');
        expect(e.maxRequests).toBe(60);
        expect(e.windowSeconds).toBe(3600);
    });

    it('household scope stamps householdId into message', () => {
        const e = new LLMRateLimitError({ scope: 'household', householdId: 'h1', maxRequests: 400, windowSeconds: 3600 });
        expect(e.scope).toBe('household');
        expect(e.message).toContain('h1');
        expect(e.message).toContain('400');
    });

    it('message uses override numbers, not defaults', () => {
        const e = new LLMRateLimitError({ scope: 'household', householdId: 'h1', maxRequests: 400, windowSeconds: 1800 });
        expect(e.message).toContain('400');
        expect(e.message).toContain('1800');
        expect(e.message).not.toContain('200');
    });

    it('instanceof Error', () => {
        const e = new LLMRateLimitError({ appId: 'chatbot', maxRequests: 60, windowSeconds: 3600 });
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(LLMRateLimitError);
    });
});
