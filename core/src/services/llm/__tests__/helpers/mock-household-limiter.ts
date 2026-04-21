import { vi } from 'vitest';
import { PLATFORM_SYSTEM_HOUSEHOLD_ID } from '../../../../types/auth-actor.js';

export const PLATFORM_NOOP_RESERVATION = 'PLATFORM_NOOP' as const;

export type MockHouseholdLimiter = {
	attribute: ReturnType<typeof vi.fn>;
	check: ReturnType<typeof vi.fn>;
	checkCost: ReturnType<typeof vi.fn>;
	reserveEstimated: ReturnType<typeof vi.fn>;
	releaseReservation: ReturnType<typeof vi.fn>;
	revokeLastCheckCommit: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

export function createMockHouseholdLimiter(
	overrides: Partial<MockHouseholdLimiter> = {},
): MockHouseholdLimiter {
	return {
		attribute: vi.fn((hhId: string | undefined) =>
			!hhId || hhId === PLATFORM_SYSTEM_HOUSEHOLD_ID ? 'platform' : 'enforced',
		),
		check: vi.fn((hhId: string | undefined) => ({
			allowed: true,
			commit: vi.fn(),
			limit:
				!hhId || hhId === PLATFORM_SYSTEM_HOUSEHOLD_ID
					? { maxRequests: Number.POSITIVE_INFINITY, windowSeconds: Number.POSITIVE_INFINITY }
					: { maxRequests: 200, windowSeconds: 3600 },
		})),
		checkCost: vi.fn(),
		reserveEstimated: vi.fn((hhId: string | undefined) =>
			!hhId || hhId === PLATFORM_SYSTEM_HOUSEHOLD_ID ? PLATFORM_NOOP_RESERVATION : 'res-test-1',
		),
		releaseReservation: vi.fn(),
		revokeLastCheckCommit: vi.fn(),
		dispose: vi.fn(),
		...overrides,
	};
}
