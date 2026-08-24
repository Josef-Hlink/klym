import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		// $env/* are virtual modules the SvelteKit plugin only provides during
		// dev/build, so server code reading them is unimportable here without a
		// stand-in. See src/lib/test-shims/.
		alias: {
			'$env/dynamic/private': fileURLToPath(
				new URL('./src/lib/test-shims/env-dynamic-private.ts', import.meta.url)
			)
		}
	}
});
