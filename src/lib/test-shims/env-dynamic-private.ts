// Stand-in for SvelteKit's $env/dynamic/private under vitest, which runs
// outside the dev/build pipeline that provides that virtual module. Aliased in
// vite.config.ts (test.alias). Same contract: a live view of process.env.
export const env = process.env as Record<string, string | undefined>;
