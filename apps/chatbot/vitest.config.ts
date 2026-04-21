import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@pas/core': join(__dirname, '../../core/src'),
		},
	},
	test: {
		globals: false,
		environment: 'node',
		passWithNoTests: true,
		include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
	},
});
