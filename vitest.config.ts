import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: ['core', 'apps/*'],
		passWithNoTests: true,
	},
});
