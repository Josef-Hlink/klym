import type { RouteData, RouteSummary, SegmentData } from '$lib/types.js';

// In-memory, per-visitor storage. All data is scoped to an `owner` (the
// anonymous klym_sid session id assigned in hooks.server.ts). Nothing is
// persisted to disk: a process restart or an idle-session sweep drops it,
// which is the intended behaviour for the hosted, login-less app.

interface RouteRecord {
	route: RouteData;
	segments: Map<string, SegmentData>;
}

interface Session {
	routes: Map<string, RouteRecord>;
	lastSeen: number;
}

// Bounds to keep a single misbehaving visitor (or many visitors) from
// exhausting memory on a small box. Overflow evicts the oldest entry.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // drop sessions idle > 6h
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min
const MAX_SESSIONS = 200;
const MAX_ROUTES_PER_SESSION = 50;
const MAX_SEGMENTS_PER_ROUTE = 100;

const sessions = new Map<string, Session>();

let sweepStarted = false;
function ensureSweep() {
	if (sweepStarted) return;
	sweepStarted = true;
	const timer = setInterval(() => {
		const cutoff = Date.now() - SESSION_TTL_MS;
		for (const [id, s] of sessions) {
			if (s.lastSeen < cutoff) sessions.delete(id);
		}
	}, SWEEP_INTERVAL_MS);
	// Don't keep the Node process alive solely for the sweep timer.
	timer.unref?.();
}

/** Drop the lowest-`getTime` entries of a Map until it fits `max`. */
function evictOldest<T>(map: Map<string, T>, max: number, getTime: (v: T) => number): void {
	while (map.size > max) {
		let oldestKey: string | undefined;
		let oldestVal = Infinity;
		for (const [k, v] of map) {
			const ts = getTime(v);
			if (ts < oldestVal) {
				oldestVal = ts;
				oldestKey = k;
			}
		}
		if (oldestKey === undefined) break;
		map.delete(oldestKey);
	}
}

/** Get (or lazily create) a session and mark it freshly used. */
function touch(owner: string): Session {
	ensureSweep();
	let s = sessions.get(owner);
	if (!s) {
		s = { routes: new Map(), lastSeen: Date.now() };
		sessions.set(owner, s);
		evictOldest(sessions, MAX_SESSIONS, (v) => v.lastSeen);
	} else {
		s.lastSeen = Date.now();
	}
	return s;
}

export async function routeExists(owner: string, id: string): Promise<boolean> {
	return touch(owner).routes.has(id);
}

export async function writeRoute(owner: string, id: string, route: RouteData): Promise<void> {
	const session = touch(owner);
	session.routes.set(id, { route, segments: new Map() });
	evictOldest(session.routes, MAX_ROUTES_PER_SESSION, (v) => Date.parse(v.route.createdAt));
}

export async function deleteRoute(owner: string, id: string): Promise<boolean> {
	return touch(owner).routes.delete(id);
}

export async function updateRouteName(owner: string, id: string, name: string): Promise<boolean> {
	const rec = touch(owner).routes.get(id);
	if (!rec) return false;
	rec.route = { ...rec.route, name };
	return true;
}

export async function readRoute(owner: string, id: string): Promise<RouteData | null> {
	return touch(owner).routes.get(id)?.route ?? null;
}

export async function listRoutes(owner: string): Promise<RouteSummary[]> {
	const summaries: RouteSummary[] = [];
	for (const { route } of touch(owner).routes.values()) {
		const { points, bounds, ...rest } = route;
		summaries.push({ ...rest, pointCount: points.length });
	}
	summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return summaries;
}

export async function segmentExists(
	owner: string,
	routeId: string,
	segId: string
): Promise<boolean> {
	return touch(owner).routes.get(routeId)?.segments.has(segId) ?? false;
}

export async function readSegment(
	owner: string,
	routeId: string,
	segId: string
): Promise<SegmentData | null> {
	return touch(owner).routes.get(routeId)?.segments.get(segId) ?? null;
}

export async function writeSegment(owner: string, segment: SegmentData): Promise<void> {
	const rec = touch(owner).routes.get(segment.routeId);
	if (!rec) return;
	rec.segments.set(segment.id, segment);
	evictOldest(rec.segments, MAX_SEGMENTS_PER_ROUTE, (v) => Date.parse(v.createdAt));
}

export async function deleteSegment(
	owner: string,
	routeId: string,
	segId: string
): Promise<boolean> {
	return touch(owner).routes.get(routeId)?.segments.delete(segId) ?? false;
}

export async function updateSegment(
	owner: string,
	routeId: string,
	segId: string,
	patch: Partial<Pick<SegmentData, 'name' | 'startDistM' | 'endDistM' | 'binSizeM'>>
): Promise<boolean> {
	const segments = touch(owner).routes.get(routeId)?.segments;
	const seg = segments?.get(segId);
	if (!segments || !seg) return false;
	segments.set(segId, { ...seg, ...patch });
	return true;
}

export async function listSegments(owner: string, routeId: string): Promise<SegmentData[]> {
	const rec = touch(owner).routes.get(routeId);
	if (!rec) return [];
	return [...rec.segments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
