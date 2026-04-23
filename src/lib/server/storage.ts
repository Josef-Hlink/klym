import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RouteData, RouteSummary } from '$lib/types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');

function routeDir(id: string) {
	return path.join(DATA_DIR, id);
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
