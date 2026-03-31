import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		passWithNoTests: true,
		include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
		exclude: ['node_modules', 'dist', 'src/cli/templates/**'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
		},
	},
	resolve: {
		alias: {
			'@core': new URL('./src', import.meta.url).pathname,
		},
	},
});
