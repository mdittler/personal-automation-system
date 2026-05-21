import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		environment: 'node',
		passWithNoTests: true,
		include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
		exclude: ['node_modules', 'dist', 'src/cli/templates/**'],
		// Vitest's 5000ms default is too tight for this package's `composeRuntime`
		// integration tests: building a full runtime takes ~250ms–1.6s, and under
		// full-suite CPU contention (534 files in parallel) a composeRuntime-backed
		// test or hook intermittently exceeds 5000ms — the "rare intermittent
		// full-suite flake" that passes in isolation and on rerun. A generous
		// timeout does not slow passing tests; it only changes when a genuinely
		// hung test is killed. Guarded by src/__tests__/vitest-timeout-config.test.ts.
		testTimeout: 30_000,
		hookTimeout: 30_000,
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
