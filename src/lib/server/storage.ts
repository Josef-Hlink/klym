import type { RouteBounds, RouteData, RouteSummary, SegmentData } from '$lib/types.js';
import { getBuiltinRoute } from './builtin.js';
import { db, type Sql } from './db.js';

// Durable, per-visitor storage in postgres. All data is scoped to an `owner`
// (the anonymous klym_sid session id assigned in hooks.server.ts). Schema lives
// in ./migrations; the connection and the migration runner live in ./db.ts.
//
// Reads additionally fall back to the shared read-only builtin registry
// (builtin.ts — the grand tour stages), so builtin routes open like any other.
// Builtin RouteData is never inserted: what gets stored for a stage is a hidden
// overlay row (builtin = true, point columns null) that holds a visitor's own
// segments, excluded from listRoutes and not renameable.

// Abuse bounds, not memory bounds — overflow evicts the owner's oldest entry.
// (The old MAX_SESSIONS cap was purely a memory bound and is gone; owners are
// now collected by the idle sweep in db.ts instead.)
const MAX_ROUTES_PER_OWNER = 50;
const MAX_SEGMENTS_PER_ROUTE = 100;

type RouteRow = {
	id: string;
	name: string;
	points: string | null;
	bounds: RouteBounds | null;
	total_dist_m: number | null;
	total_ascent_m: number | null;
	point_count: number | null;
	created_at: Date;
};

type SegmentRow = {
	id: string;
	route_id: string;
	name: string;
	start_dist_m: number;
	end_dist_m: number;
	bin_size_m: number;
	created_at: Date;
};

function toSegment(row: SegmentRow): SegmentData {
	return {
		id: row.id,
		routeId: row.route_id,
		name: row.name,
		startDistM: row.start_dist_m,
		endDistM: row.end_dist_m,
		binSizeM: row.bin_size_m,
		createdAt: row.created_at.toISOString()
	};
}

/** Insert the owner if new, and mark it freshly used. */
async function touch(sql: Sql, owner: string): Promise<void> {
	await sql`
		insert into owners (id) values (${owner})
		on conflict (id) do update set last_seen = now()`;
}

/** Drop the owner's oldest routes until they fit the cap. */
async function evictRoutes(sql: Sql, owner: string): Promise<void> {
	await sql`
		delete from routes where owner_id = ${owner} and id in (
			select id from routes where owner_id = ${owner}
			order by created_at desc offset ${MAX_ROUTES_PER_OWNER}
		)`;
}

/** Drop the route's oldest segments until they fit the cap. */
async function evictSegments(sql: Sql, owner: string, routeId: string): Promise<void> {
	await sql`
		delete from segments
		where owner_id = ${owner} and route_id = ${routeId} and id in (
			select id from segments where owner_id = ${owner} and route_id = ${routeId}
			order by created_at desc offset ${MAX_SEGMENTS_PER_ROUTE}
		)`;
}

export async function routeExists(owner: string, id: string): Promise<boolean> {
	const sql = await db();
	const rows = await sql`select 1 from routes where owner_id = ${owner} and id = ${id} limit 1`;
	return rows.length > 0 || (await getBuiltinRoute(id)) != null;
}

export async function writeRoute(owner: string, id: string, route: RouteData): Promise<void> {
	const sql = await db();
	await touch(sql, owner);
	await sql`
		insert into routes (
			owner_id, id, name, points, bounds,
			total_dist_m, total_ascent_m, point_count, builtin, created_at
		) values (
			${owner}, ${id}, ${route.name}, ${JSON.stringify(route.points)},
			${sql.json(route.bounds)}, ${route.totalDistM}, ${route.totalAscentM},
			${route.points.length}, false, ${route.createdAt}
		)
		on conflict (owner_id, id) do update set
			name = excluded.name,
			points = excluded.points,
			bounds = excluded.bounds,
			total_dist_m = excluded.total_dist_m,
			total_ascent_m = excluded.total_ascent_m,
			point_count = excluded.point_count,
			builtin = false,
			created_at = excluded.created_at`;
	await evictRoutes(sql, owner);
}

export async function deleteRoute(owner: string, id: string): Promise<boolean> {
	const sql = await db();
	// Deliberately not filtered on `builtin`: deleting a stage's overlay row
	// (and with it the visitor's segments on that stage) is what the in-memory
	// store did, and the stage itself is untouched — it lives in builtin.ts.
	const rows = await sql`
		delete from routes where owner_id = ${owner} and id = ${id} returning id`;
	return rows.length > 0;
}

export async function updateRouteName(owner: string, id: string, name: string): Promise<boolean> {
	const sql = await db();
	const rows = await sql`
		update routes set name = ${name}
		where owner_id = ${owner} and id = ${id} and not builtin
		returning id`;
	return rows.length > 0;
}

export async function readRoute(owner: string, id: string): Promise<RouteData | null> {
	const sql = await db();
	// `points is not null` skips builtin overlay rows, which carry segments but
	// no route data — those fall through to the shared registry below.
	const rows = await sql<RouteRow[]>`
		select id, name, points, bounds, total_dist_m, total_ascent_m, point_count, created_at
		from routes
		where owner_id = ${owner} and id = ${id} and points is not null`;
	const row = rows[0];
	if (!row) return await getBuiltinRoute(id);
	return {
		id: row.id,
		name: row.name,
		points: JSON.parse(row.points as string),
		totalDistM: row.total_dist_m as number,
		totalAscentM: row.total_ascent_m as number,
		bounds: row.bounds as RouteBounds,
		createdAt: row.created_at.toISOString()
	};
}

export async function listRoutes(owner: string): Promise<RouteSummary[]> {
	const sql = await db();
	// Metadata columns only — never the points blob. That split is the whole
	// reason point_count is denormalized.
	const rows = await sql<RouteRow[]>`
		select id, name, total_dist_m, total_ascent_m, point_count, created_at
		from routes
		where owner_id = ${owner} and not builtin
		order by created_at desc`;
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		totalDistM: row.total_dist_m as number,
		totalAscentM: row.total_ascent_m as number,
		pointCount: row.point_count as number,
		createdAt: row.created_at.toISOString()
	}));
}

export async function segmentExists(
	owner: string,
	routeId: string,
	segId: string
): Promise<boolean> {
	const sql = await db();
	const rows = await sql`
		select 1 from segments
		where owner_id = ${owner} and route_id = ${routeId} and id = ${segId} limit 1`;
	return rows.length > 0;
}

export async function readSegment(
	owner: string,
	routeId: string,
	segId: string
): Promise<SegmentData | null> {
	const sql = await db();
	const rows = await sql<SegmentRow[]>`
		select id, route_id, name, start_dist_m, end_dist_m, bin_size_m, created_at
		from segments
		where owner_id = ${owner} and route_id = ${routeId} and id = ${segId}`;
	return rows[0] ? toSegment(rows[0]) : null;
}

export async function writeSegment(owner: string, segment: SegmentData): Promise<void> {
	const sql = await db();
	const existing = await sql`
		select 1 from routes where owner_id = ${owner} and id = ${segment.routeId} limit 1`;

	if (existing.length === 0) {
		// Saving onto a builtin route: materialize the hidden overlay row. The
		// stage's RouteData stays in the shared registry — only the segments are
		// per-visitor.
		const route = await getBuiltinRoute(segment.routeId);
		if (!route) return;
		await touch(sql, owner);
		await sql`
			insert into routes (owner_id, id, name, builtin, created_at)
			values (${owner}, ${segment.routeId}, ${route.name}, true, ${route.createdAt})
			on conflict (owner_id, id) do nothing`;
		await evictRoutes(sql, owner);
	} else {
		await touch(sql, owner);
	}

	await sql`
		insert into segments (
			owner_id, route_id, id, name, start_dist_m, end_dist_m, bin_size_m, created_at
		) values (
			${owner}, ${segment.routeId}, ${segment.id}, ${segment.name},
			${segment.startDistM}, ${segment.endDistM}, ${segment.binSizeM}, ${segment.createdAt}
		)
		on conflict (owner_id, route_id, id) do update set
			name = excluded.name,
			start_dist_m = excluded.start_dist_m,
			end_dist_m = excluded.end_dist_m,
			bin_size_m = excluded.bin_size_m,
			created_at = excluded.created_at`;
	await evictSegments(sql, owner, segment.routeId);
}

export async function deleteSegment(
	owner: string,
	routeId: string,
	segId: string
): Promise<boolean> {
	const sql = await db();
	const rows = await sql`
		delete from segments
		where owner_id = ${owner} and route_id = ${routeId} and id = ${segId}
		returning id`;
	return rows.length > 0;
}

export async function updateSegment(
	owner: string,
	routeId: string,
	segId: string,
	patch: Partial<Pick<SegmentData, 'name' | 'startDistM' | 'endDistM' | 'binSizeM'>>
): Promise<boolean> {
	const sql = await db();
	const cols: Record<string, string | number> = {};
	if (patch.name !== undefined) cols.name = patch.name;
	if (patch.startDistM !== undefined) cols.start_dist_m = patch.startDistM;
	if (patch.endDistM !== undefined) cols.end_dist_m = patch.endDistM;
	if (patch.binSizeM !== undefined) cols.bin_size_m = patch.binSizeM;
	// An empty patch is a no-op that still reports whether the segment is there,
	// matching the in-memory behaviour.
	if (Object.keys(cols).length === 0) return await segmentExists(owner, routeId, segId);

	const rows = await sql`
		update segments set ${sql(cols)}
		where owner_id = ${owner} and route_id = ${routeId} and id = ${segId}
		returning id`;
	return rows.length > 0;
}

export async function listSegments(owner: string, routeId: string): Promise<SegmentData[]> {
	const sql = await db();
	const rows = await sql<SegmentRow[]>`
		select id, route_id, name, start_dist_m, end_dist_m, bin_size_m, created_at
		from segments
		where owner_id = ${owner} and route_id = ${routeId}
		order by created_at desc`;
	return rows.map(toSegment);
}
