import { mkdir, readdir, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RouteData, RouteSummary, SegmentData } from '$lib/types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');

function routeDir(id: string) {
	return path.join(DATA_DIR, id);
}

function segmentsDir(routeId: string) {
	return path.join(routeDir(routeId), 'segments');
}

function segmentFile(routeId: string, segId: string) {
	return path.join(segmentsDir(routeId), `${segId}.json`);
}

export async function routeExists(id: string): Promise<boolean> {
	try {
		await stat(path.join(routeDir(id), 'route.json'));
		return true;
	} catch {
		return false;
	}
}

export async function writeRoute(
	id: string,
	gpxText: string,
	route: RouteData
): Promise<void> {
	const dir = routeDir(id);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, 'route.gpx'), gpxText, 'utf8');
	await writeFile(path.join(dir, 'route.json'), JSON.stringify(route), 'utf8');
}

export async function readRoute(id: string): Promise<RouteData | null> {
	try {
		const text = await readFile(path.join(routeDir(id), 'route.json'), 'utf8');
		return JSON.parse(text) as RouteData;
	} catch {
		return null;
	}
}

export async function listRoutes(): Promise<RouteSummary[]> {
	let entries: string[];
	try {
		entries = await readdir(DATA_DIR);
	} catch {
		return [];
	}
	const summaries: RouteSummary[] = [];
	for (const id of entries) {
		const route = await readRoute(id);
		if (!route) continue;
		const { points, bounds, ...rest } = route;
		summaries.push({ ...rest, pointCount: points.length });
	}
	summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return summaries;
}

export async function segmentExists(routeId: string, segId: string): Promise<boolean> {
	try {
		await stat(segmentFile(routeId, segId));
		return true;
	} catch {
		return false;
	}
}

export async function readSegment(routeId: string, segId: string): Promise<SegmentData | null> {
	try {
		const text = await readFile(segmentFile(routeId, segId), 'utf8');
		return JSON.parse(text) as SegmentData;
	} catch {
		return null;
	}
}

export async function writeSegment(segment: SegmentData): Promise<void> {
	await mkdir(segmentsDir(segment.routeId), { recursive: true });
	await writeFile(
		segmentFile(segment.routeId, segment.id),
		JSON.stringify(segment),
		'utf8'
	);
}

export async function deleteSegment(routeId: string, segId: string): Promise<boolean> {
	try {
		await unlink(segmentFile(routeId, segId));
		return true;
	} catch {
		return false;
	}
}

export async function listSegments(routeId: string): Promise<SegmentData[]> {
	let files: string[];
	try {
		files = await readdir(segmentsDir(routeId));
	} catch {
		return [];
	}
	const segments: SegmentData[] = [];
	for (const f of files) {
		if (!f.endsWith('.json')) continue;
		try {
			const text = await readFile(path.join(segmentsDir(routeId), f), 'utf8');
			segments.push(JSON.parse(text) as SegmentData);
		} catch {
			/* skip malformed */
		}
	}
	segments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return segments;
}
