import { env } from '$env/dynamic/private';
import postgres from 'postgres';

// Connection handle + migration runner. Everything in storage.ts starts with
// `await db()`, so migrations run exactly once per process, before the first
// query, awaited by every caller — no ExecStartPre, no ordering window.
//
// A failure here is deliberately fatal: the process exits non-zero, systemd's
// Restart=on-failure retries, and a database that is genuinely down leaves klym
// down rather than silently serving an empty store.

export type Sql = ReturnType<typeof postgres>;

// Migrations are inlined into the bundle at build time, exactly like the
// builtin GPX stages in builtin.ts. adapter-node only emits what Vite bundles,
// so loose .sql files under src/ would never reach build/ — this way there is
// nothing to copy in the flake's installPhase and a migration can't be present
// in git but missing at runtime.
const MIGRATIONS = import.meta.glob('./migrations/*.sql', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

// Orphan collection, not a memory bound (that's what the in-memory sweep was).
// A visitor who hasn't been seen in this long has almost certainly lost the
// cookie that points at their rows.
const OWNER_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

let handle: Promise<Sql> | null = null;

export function db(): Promise<Sql> {
	return (handle ??= connect());
}

async function connect(): Promise<Sql> {
	const url = env.DATABASE_URL;
	if (!url) {
		throw new Error(
			'DATABASE_URL is not set. klym needs postgres — see HOSTING.md ' +
				'(prod: postgresql:///klym?host=/run/postgresql).'
		);
	}
	const { dsn, options } = normalize(url);
	const sql = postgres(dsn, { onnotice: () => {}, ...options });
	await migrate(sql);
	startSweep(sql);
	return sql;
}

// libpq spells a unix socket as `postgresql:///db?host=/run/postgresql`, and
// that's the form psql/pg_dump/pg_service all take. postgres.js doesn't: it
// reads only the URL's *host component*, so that URL silently resolves to TCP
// localhost and fails auth. Worse, any query param it doesn't recognise is
// forwarded as a startup parameter, so leaving `host` in place makes the server
// reject the connection with `unrecognized configuration parameter "host"`.
// Lift it out into an explicit option rather than documenting a second,
// driver-specific URL that psql wouldn't accept.
function normalize(url: string): { dsn: string; options: { host?: string } } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { dsn: url, options: {} };
	}
	const socket = parsed.searchParams.get('host');
	if (!socket?.startsWith('/')) return { dsn: url, options: {} };
	parsed.searchParams.delete('host');
	return { dsn: parsed.toString(), options: { host: socket } };
}

/** Apply un-applied migrations in filename order, one transaction each. */
async function migrate(sql: Sql): Promise<void> {
	await sql`create table if not exists _migrations (
		name text primary key,
		applied_at timestamptz not null default now()
	)`;
	const rows = await sql<{ name: string }[]>`select name from _migrations`;
	const applied = new Set(rows.map((r) => r.name));

	for (const path of Object.keys(MIGRATIONS).sort()) {
		const name = path.slice(path.lastIndexOf('/') + 1);
		if (applied.has(name)) continue;
		// Postgres has transactional DDL, so a migration that fails part-way
		// rolls back whole — never half-applied.
		await sql.begin(async (tx) => {
			// .simple() because a migration file holds several statements and the
			// extended protocol only accepts one per round-trip.
			await tx.unsafe(MIGRATIONS[path]).simple();
			await tx`insert into _migrations (name) values (${name})`;
		});
		console.log(`[klym] applied migration ${name}`);
	}
}

let sweepStarted = false;
function startSweep(sql: Sql): void {
	if (sweepStarted) return;
	sweepStarted = true;
	const timer = setInterval(() => {
		const cutoff = new Date(Date.now() - OWNER_TTL_MS);
		// Routes and segments cascade off the owner row.
		sql`delete from owners where last_seen < ${cutoff}`.catch((err) => {
			console.error('[klym] owner sweep failed', err);
		});
	}, SWEEP_INTERVAL_MS);
	// Don't keep the Node process alive solely for the sweep timer.
	timer.unref?.();
}
