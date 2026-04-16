/**
 * D5b-2: Compile-only tests for AuthenticatedActor.
 *
 * These tests verify that:
 * 1. The type is exported and can be assigned to a typed variable.
 * 2. Optional fields (scopes, sessionVersion) can be omitted.
 * 3. The well-known sentinel constants are exported.
 *
 * No runtime logic is exercised — if this file compiles and the test runner
 * reports 0 failures, D5b-2 is satisfied.
 */
import { describe, expect, it } from 'vitest';
import {
	PLATFORM_SYSTEM_HOUSEHOLD_ID,
	PLATFORM_SYSTEM_USER_ID,
	type AuthenticatedActor,
} from '../auth-actor.js';

describe('AuthenticatedActor type', () => {
	it('can construct a minimal GUI actor with no optional fields', () => {
		const actor: AuthenticatedActor = {
			userId: '123456789',
			householdId: 'hh-main',
			isPlatformAdmin: false,
			isHouseholdAdmin: false,
			authMethod: 'gui-password',
		};
		// Runtime assertion so vitest counts this as a passing test
		expect(actor.userId).toBe('123456789');
		expect(actor.scopes).toBeUndefined();
		expect(actor.sessionVersion).toBeUndefined();
	});

	it('can construct a platform-admin GUI actor with sessionVersion', () => {
		const actor: AuthenticatedActor = {
			userId: '987654321',
			householdId: 'hh-main',
			isPlatformAdmin: true,
			isHouseholdAdmin: true,
			authMethod: 'gui-password',
			sessionVersion: 3,
		};
		expect(actor.isPlatformAdmin).toBe(true);
		expect(actor.sessionVersion).toBe(3);
		expect(actor.scopes).toBeUndefined();
	});

	it('can construct a legacy-api-token platform-system actor with scopes', () => {
		const actor: AuthenticatedActor = {
			userId: PLATFORM_SYSTEM_USER_ID,
			householdId: PLATFORM_SYSTEM_HOUSEHOLD_ID,
			isPlatformAdmin: true,
			isHouseholdAdmin: false,
			authMethod: 'legacy-api-token',
			scopes: ['*'],
		};
		expect(actor.userId).toBe('__platform_system__');
		expect(actor.householdId).toBe('__platform__');
		expect(actor.scopes).toEqual(['*']);
	});

	it('can construct a per-user API key actor with specific scopes', () => {
		const actor: AuthenticatedActor = {
			userId: '123456789',
			householdId: 'hh-main',
			isPlatformAdmin: false,
			isHouseholdAdmin: false,
			authMethod: 'api-key',
			scopes: ['data:read', 'messages:send'],
		};
		expect(actor.scopes).toContain('data:read');
		expect(actor.sessionVersion).toBeUndefined();
	});

	it('PLATFORM_SYSTEM_USER_ID and PLATFORM_SYSTEM_HOUSEHOLD_ID are exported constants', () => {
		expect(PLATFORM_SYSTEM_USER_ID).toBe('__platform_system__');
		expect(PLATFORM_SYSTEM_HOUSEHOLD_ID).toBe('__platform__');
	});
});
