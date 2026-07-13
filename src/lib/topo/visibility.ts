// Geometric route visibility over the terrain mesh (segment topo view).
//
// The route always draws ON TOP of the terrain mesh as full, continuous
// polylines — it is never woven into the mesh's painter sweep. (That was
// tried, twice: a per-pixel ray test feeding dashed polylines, then
// painter interleaving with per-cell route runs. Both live on the
// `occlusion-dead-end` branch as a record of why not: stroke width,
// translucent shadows and supporting-slope burial turn paint-level
// occlusion into an artifact factory.) Instead, stretches of the route
// that are clearly BEHIND terrain are dropped from the solid polylines;
// the component draws those hidden stretches — plus stretches covered by
// a front block wall (a screen-space pointInPolygon test; the walls
// aren't terrain, so this mask can't know them) — once more as a
// low-opacity ghost on top, so everything the viewer can't see solid
// stays traceable.
//
// Per route point we march the orthographic view ray toward the camera
// across the DEM and hide the point when terrain rises clearly above the
// ray. The camera direction comes from projection.ts's rotate3d: pitch 0
// is top-down (ray straight up — nothing can occlude), pitch → π/2 is
// horizon; toward-camera is (−sin yaw, −cos yaw) horizontally, climbing
// cos(pitch)/sin(pitch) exaggerated metres per horizontal metre.
//
// Three ingredients keep the mask stable and streak-free:
// - CLEARANCE: a point stays visible only if the ray clears the terrain
//   by CLEAR_M everywhere it is tested — near silhouettes the route
//   tucks behind the ridge a touch early rather than hovering in front
//   of the far side.
// - NEAR SKIP: terrain within ~one cell of the point never occludes it —
//   that's the DEM's resolution limit, where the interpolated surface
//   can poke a few metres above a road bench the grid can't resolve.
//   Real landforms beyond a cell always occlude (full occlusion is the
//   product choice).
// - SMOOTHING: interior visible/hidden islands shorter than
//   MIN_ISLAND_M are absorbed by their surroundings, so the mask can't
//   speckle or dash.

import { M_PER_DEG } from './projection.js';
import { demEleAt, type DemGrid } from './dem.js';

export type VisibilityCamera = {
	yaw: number;
	pitch: number;
	zExaggeration: number;
};

// Required ray clearance over terrain (real metres, pre-exaggeration).
export const CLEAR_M = 5;
// Interior visible/hidden islands shorter than this (route metres) flip.
export const MIN_ISLAND_M = 150;
// The near skip is SMALL and constant: about one DEM cell (floored in
// metres for tiny segments). It only exists to absorb sub-cell DEM
// roughness right next to the road (benches and cuts the coarse grid
// can't resolve) — the 10 m float plus CLEAR_M need a little help at
// the grid's resolution limit. It must NOT scale with pitch or relief:
// a route on its camera-facing slope needs no protection at all (along
// the view ray the terrain falls away while the ray climbs — the
// painter-era "supporting-slope burial" was a paint-order artifact, not
// a sightline one), and a generous skip x-rays the route through real
// foreground mountains, which is precisely the bug it once shipped.
export const NEAR_SKIP_CELLS = 1;
export const NEAR_SKIP_MIN_M = 150;

type VisPoint = { lat: number; lon: number; ele: number; cumDistM: number };

// true = visible. `points` carry RENDER elevations (terrain + float), so
// the test compares the same surface the mesh draws.
export function computeVisibility(
	points: readonly VisPoint[],
	grid: DemGrid,
	cam: VisibilityCamera
): boolean[] {
	const mask: boolean[] = new Array(points.length).fill(true);
	if (points.length === 0) return mask;

	const sp = Math.sin(cam.pitch);
	const cp = Math.cos(cam.pitch);
	// Top-down (or 2D): the ray leaves the ground vertically — nothing
	// can occlude the floating route.
	if (sp < 1e-4) return mask;
	// Exaggerated metres the ray gains per horizontal metre toward camera.
	const climb = cp / sp;

	const { bbox } = grid;
	const cellsX = grid.w - 1;
	const cellsY = grid.h - 1;
	const cosLat = Math.cos((((bbox.minLat + bbox.maxLat) / 2) * Math.PI) / 180);
	const cellWm = ((bbox.maxLon - bbox.minLon) * cosLat * M_PER_DEG) / cellsX;
	const cellHm = ((bbox.maxLat - bbox.minLat) * M_PER_DEG) / cellsY;
	const stepM = Math.min(cellWm, cellHm) / 2;
	const nearSkipM = Math.max(NEAR_SKIP_MIN_M, NEAR_SKIP_CELLS * Math.max(cellWm, cellHm));

	// Horizontal unit direction toward the camera (east, north).
	const ux = -Math.sin(cam.yaw);
	const uy = -Math.cos(cam.yaw);
	const dLonPerM = ux / (cosLat * M_PER_DEG);
	const dLatPerM = uy / M_PER_DEG;

	const z = cam.zExaggeration;
	const zTerrainMax = grid.maxEle * z;
	const clearEx = CLEAR_M * z;

	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		const z0 = p.ele * z;
		for (let s = nearSkipM; ; s += stepM) {
			const zRay = z0 + s * climb;
			// Ray above every possible occluder — done, visible.
			if (zRay - clearEx > zTerrainMax) break;
			const lat = p.lat + dLatPerM * s;
			const lon = p.lon + dLonPerM * s;
			if (lat < bbox.minLat || lat > bbox.maxLat || lon < bbox.minLon || lon > bbox.maxLon) {
				break; // left the DEM — no more terrain to occlude
			}
			if (demEleAt(grid, lat, lon) * z > zRay - clearEx) {
				mask[i] = false;
				break;
			}
		}
	}

	return smoothVisibility(mask, points, MIN_ISLAND_M);
}

// Absorb interior islands shorter than minIslandM: first lone visible
// glimpses inside hidden stretches, then specks of hiding inside visible
// stretches (in that order — the route's default state is visible).
// Runs touching either end of the route are never islands.
export function smoothVisibility(
	mask: readonly boolean[],
	points: readonly VisPoint[],
	minIslandM: number = MIN_ISLAND_M
): boolean[] {
	const out = [...mask];
	const absorb = (state: boolean) => {
		let i = 0;
		while (i < out.length) {
			if (out[i] !== state) {
				i++;
				continue;
			}
			let j = i;
			while (j + 1 < out.length && out[j + 1] === state) j++;
			const interior = i > 0 && j < out.length - 1;
			if (interior && points[j].cumDistM - points[i].cumDistM < minIslandM) {
				for (let k = i; k <= j; k++) out[k] = !state;
			}
			i = j + 1;
		}
	};
	absorb(true);
	absorb(false);
	return out;
}

// Visibility lookup for distance-driven features (anchor lines, dots):
// the mask value of the first point at or beyond distM.
export function visibleAtDist(
	points: readonly VisPoint[],
	mask: readonly boolean[],
	distM: number
): boolean {
	if (points.length === 0) return true;
	let lo = 0;
	let hi = points.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].cumDistM < distM) lo = mid + 1;
		else hi = mid;
	}
	return mask[lo] ?? true;
}
