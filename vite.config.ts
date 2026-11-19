import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';

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

// The dev server's reach is settable, so a zone on maria can put it behind
// caddy (listen past loopback, accept the zone's hostnames, HMR back through
// 443). Unset, everything stays on loopback. The settings come from the repo's
// .env (the same file the server reads), with the process environment taking
// precedence.
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), 'KLYM_');
	const hmrClientPort = Number(env.KLYM_HMR_CLIENT_PORT);
	return {
		plugins: [tailwindcss(), sveltekit()],
		define: {
			__APP_COMMIT__: JSON.stringify(commit),
			__APP_UPDATED__: JSON.stringify(updated)
		},
		server: {
			// Explicit IPv4 by default: `localhost` can bind ::1-only depending on
			// resolver order, and the Connect IQ simulator (garmin/) fetches
			// 127.0.0.1 (which 0.0.0.0 in a zone still serves).
			host: env.KLYM_WEB_HOST ?? '127.0.0.1',
			port: 1047,
			strictPort: true,
			allowedHosts: env.KLYM_WEB_ALLOWED_HOSTS?.split(','),
			// nix-direnv keeps symlinks to the flake inputs (all of nixpkgs) in
			// .direnv; followed, they cost ~90k watches and wedge the server.
			watch: { ignored: ['**/.direnv/**'] },
			hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined
		}
	};
});
