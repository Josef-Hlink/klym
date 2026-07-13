import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Build stamp for the lowkey footer. In the Nix build there's no .git, so the
// flake passes the rev + commit time via env (KLYM_COMMIT / KLYM_COMMIT_TIME,
// unix seconds); locally we shell out to git; otherwise 'dev'.
function sh(cmd: string): string | null {
	try {
		return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
const commit = process.env.KLYM_COMMIT ?? sh('git rev-parse --short HEAD') ?? 'dev';
const commitTimeSec = process.env.KLYM_COMMIT_TIME ?? sh('git log -1 --format=%ct');
let updated = 'dev';
if (commitTimeSec) {
	const d = new Date(Number(commitTimeSec) * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	updated = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
		d.getUTCHours()
	)}:${p(d.getUTCMinutes())} UTC`;
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		__APP_COMMIT__: JSON.stringify(commit),
		__APP_UPDATED__: JSON.stringify(updated)
	},
	// Explicit IPv4: `localhost` can bind ::1-only depending on resolver
	// order, and the Connect IQ simulator (garmin/) fetches 127.0.0.1.
	server: { port: 1047, strictPort: true, host: '127.0.0.1' }
});
