// Payload builder for the Garmin Connect IQ data field (garmin/).
//
// The Edge 540 gives a data field ~125 KB for code *and* data, and Monkey C
// turns JSON into Dictionaries with heavy per-key overhead — so the payload
// is a few parallel arrays of integers, not per-point objects. One fixed
// resample step ties everything together: index i ↔ distance
// min(i·step, dist) ↔ e[i] ↔ (lat[i], lon[i]). The device computes bucket
// grades from `e` itself (same math as computeBins), so no bar arrays are
// sent. Climbs travel as compact tuples; schema changes bump `v`.

import { findPointAtDistance } from './elevation.js';
import type { ClimbCategory, DetectedClimb } from './climbs.js';
import type { RouteData } from './types.js';

export type GarminClimbInput = Pick<
	DetectedClimb,
	'startM' | 'endM' | 'avgGrade' | 'gainM' | 'maxGrade' | 'category'
>;

/** [startM, endM, cat, avgGrade×10, gainM, maxGrade×10] — cat as in CATEGORY_CODE. */
export type GarminClimbTuple = [number, number, number, number, number, number];

export type GarminPayload = {
	v: 1;
	/** Route name, truncated to GARMIN_NAME_MAX chars. */
	name: string;
	/** Built-at time, epoch seconds (device can show staleness). */
	ts: number;
	/** Resample step, m. */
	step: number;
	/** Total route distance, m. */
	dist: number;
	/** Elevation per sample, integer decimeters. */
	e: number[];
	/** Latitude per sample, degrees × 1e5 (~1.1 m). */
	lat: number[];
	/** Longitude per sample, degrees × 1e5. */
	lon: number[];
	c: GarminClimbTuple[];
};

export const GARMIN_MAX_POINTS = 1200;
export const GARMIN_MAX_CLIMBS = 40;
export const GARMIN_NAME_MAX = 24;

/** Difficulty ascending; 0 = uncategorized. Decoded in garmin/source/Palette.mc. */
export const CATEGORY_CODE: Record<ClimbCategory, number> = {
	'4': 1,
	'3': 2,
	'2': 3,
	'1': 4,
	HC: 5
};

const CATEGORIES = new Set<string>(Object.keys(CATEGORY_CODE));

/**
 * Keep only what the device needs from detected climbs — top-level spans
 * (dropping `parts`: the zoom view wants the whole A+B parent, not slices).
 */
export function toGarminClimbInputs(climbs: DetectedClimb[]): GarminClimbInput[] {
	return climbs.map(({ startM, endM, avgGrade, gainM, maxGrade, category }) => ({
		startM,
		endM,
		avgGrade,
		gainM,
		maxGrade,
		category
	}));
}

/**
 * Validate client-supplied climbs (they arrive as JSON in a hidden form
 * field). Entries that aren't finite, ordered, inside the route, or carry an
 * unknown category are dropped; survivors are sorted and capped.
 */
export function sanitizeGarminClimbs(raw: unknown, totalDistM: number): GarminClimbInput[] {
	if (!Array.isArray(raw)) return [];
	const out: GarminClimbInput[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const { startM, endM, avgGrade, gainM, maxGrade, category } = item as Record<
			string,
			unknown
		>;
		if (
			typeof startM !== 'number' ||
			typeof endM !== 'number' ||
			typeof avgGrade !== 'number' ||
			typeof gainM !== 'number' ||
			typeof maxGrade !== 'number' ||
			![startM, endM, avgGrade, gainM, maxGrade].every(Number.isFinite)
		) {
			continue;
		}
		if (startM < 0 || endM <= startM || startM >= totalDistM) continue;
		const cat =
			category == null ? null : CATEGORIES.has(String(category)) ? (category as ClimbCategory) : undefined;
		if (cat === undefined) continue;
		out.push({
			startM,
			endM: Math.min(endM, totalDistM),
			avgGrade,
			gainM,
			maxGrade,
			category: cat
		});
	}
	out.sort((a, b) => a.startM - b.startM);
	return out.slice(0, GARMIN_MAX_CLIMBS);
}

function toTuple(c: GarminClimbInput): GarminClimbTuple {
	return [
		Math.round(c.startM),
		Math.round(c.endM),
		c.category ? CATEGORY_CODE[c.category] : 0,
		Math.round(c.avgGrade * 10),
		Math.round(c.gainM),
		Math.round(c.maxGrade * 10)
	];
}

export function buildGarminPayload(
	route: RouteData,
	climbs: GarminClimbInput[],
	opts: { maxPoints?: number; now?: Date } = {}
): GarminPayload {
	const maxPoints = opts.maxPoints ?? GARMIN_MAX_POINTS;
	const dist = Math.round(route.totalDistM);
	// Round the step up to a clean 10 m so it stays ≥ dist/maxPoints.
	const step = Math.max(50, Math.ceil(dist / maxPoints / 10) * 10);
	const n = Math.max(2, Math.ceil(dist / step) + 1);

	const e = new Array<number>(n);
	const lat = new Array<number>(n);
	const lon = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		// The last sample clamps to the exact route end so the profile,
		// locator, and climb spans all agree on where the route stops.
		const p = findPointAtDistance(route.points, Math.min(i * step, dist));
		e[i] = Math.round(p.ele * 10);
		lat[i] = Math.round(p.lat * 1e5);
		lon[i] = Math.round(p.lon * 1e5);
	}

	const sorted = [...climbs].sort((a, b) => a.startM - b.startM);

	return {
		v: 1,
		name: route.name.trim().slice(0, GARMIN_NAME_MAX),
		ts: Math.floor((opts.now ?? new Date()).getTime() / 1000),
		step,
		dist,
		e,
		lat,
		lon,
		c: sorted.slice(0, GARMIN_MAX_CLIMBS).map(toTuple)
	};
}
