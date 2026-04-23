import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
	resolve: {
		// Allow Vite to resolve packages from core's node_modules so imports
		// like 'pino' work in scripts that don't have their own package.json.
		alias: {
			pino: resolve(__dirname, '../core/node_modules/pino/pino.js'),
		},
	},
	test: {
		include: ['**/__tests__/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
});
