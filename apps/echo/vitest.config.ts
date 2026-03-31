import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		passWithNoTests: true,
		include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
	},
});
