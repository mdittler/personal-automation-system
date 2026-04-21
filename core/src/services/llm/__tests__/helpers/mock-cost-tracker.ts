import { vi } from 'vitest';
import type { CostTracker } from '../../cost-tracker.js';

export function createMockCostTracker(appCost = 0, totalCost = 0, householdCost = 0): CostTracker {
	return {
		record: vi.fn().mockResolvedValue(undefined),
		getMonthlyAppCost: vi.fn().mockReturnValue(appCost),
		getMonthlyTotalCost: vi.fn().mockReturnValue(totalCost),
		getMonthlyUserCosts: vi.fn().mockReturnValue(new Map()),
		getMonthlyAppCosts: vi.fn().mockReturnValue(new Map()),
		getMonthlyHouseholdCost: vi.fn().mockReturnValue(householdCost),
		getMonthlyHouseholdCosts: vi.fn().mockReturnValue(new Map()),
		reserveEstimated: vi.fn().mockReturnValue('res-test-1'),
		releaseReservation: vi.fn(),
		flush: vi.fn().mockResolvedValue(undefined),
		loadMonthlyCache: vi.fn().mockResolvedValue(undefined),
		estimateCost: vi.fn().mockReturnValue(0),
		readUsage: vi.fn().mockResolvedValue(''),
	} as unknown as CostTracker;
}
