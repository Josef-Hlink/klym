import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// Explicit IPv4: `localhost` can bind ::1-only depending on resolver
	// order, and the Connect IQ simulator (garmin/) fetches 127.0.0.1.
	server: { port: 1047, strictPort: true, host: '127.0.0.1' }
});
