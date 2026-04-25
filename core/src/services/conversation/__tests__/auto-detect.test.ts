import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import { getAutoDetectSetting } from '../auto-detect.js';

describe('getAutoDetectSetting', () => {
	it('returns true when config has auto_detect_pas=true', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: true });
		const result = await getAutoDetectSetting('user1', { config: services.config });
		expect(result).toBe(true);
	});

	it('returns true when config has auto_detect_pas="true" (string form)', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: 'true' });
		const result = await getAutoDetectSetting('user1', { config: services.config });
		expect(result).toBe(true);
	});

	it('returns false when config has auto_detect_pas=false', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockResolvedValue({ auto_detect_pas: false });
		const result = await getAutoDetectSetting('user1', { config: services.config });
		expect(result).toBe(false);
	});

	it('returns false when config service is unavailable (graceful default)', async () => {
		const result = await getAutoDetectSetting('user1', {});
		expect(result).toBe(false);
	});

	it('returns false when config.getAll throws', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.config.getAll).mockRejectedValue(new Error('config error'));
		const result = await getAutoDetectSetting('user1', { config: services.config });
		expect(result).toBe(false);
	});
});
