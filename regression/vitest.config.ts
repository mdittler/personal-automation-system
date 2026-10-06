import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
		passWithNoTests: true,
	},
	resolve: {
		alias: [
			// Match the path aliases in tsconfig.json so vitest can resolve them at
			// runtime.
			{ find: /^@regression\/(.*)$/, replacement: here('./src/$1') },
			{ find: /^@core\/(.*)$/, replacement: here('../core/src/$1') },
			{ find: /^@food\/(.*)$/, replacement: here('../apps/food/src/$1') },
			// Apps import core helpers through the package export map
			// (`@pas/core/utils/...` -> `core/dist/...`). Resolve them to source so
			// tests never run against a stale build artifact.
			{ find: /^@pas\/core\/(.*)$/, replacement: here('../core/src/$1') },
		],
	},
});
