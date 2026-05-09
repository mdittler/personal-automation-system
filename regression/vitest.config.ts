import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
		passWithNoTests: true,
	},
	resolve: {
		alias: {
			// Match the path aliases in tsconfig.json so vitest can resolve them at
			// runtime. Order matters — `@core/types/...` style imports map cleanly
			// because vitest checks each prefix.
			'@regression': here('./src'),
			'@core': here('../core/src'),
			'@food': here('../apps/food/src'),
		},
	},
});
