import { describe, it, expect } from 'vitest';
import type { DemGrid } from './dem.js';
import { computeVisibility, smoothVisibility, visibleAtDist } from './visibility.js';

// Synthetic grid helper (same pattern as dem.test.ts).
function makeGrid(
	w: number,
	h: number,
	bbox: DemGrid['bbox'],
	eleAt: (r: number, c: number) => number
): DemGrid {
	const ele = new Float32Array(w * h);
	let minEle = Infinity;
	let maxEle = -Infinity;
	for (let r = 0; r < h; r++) {
		for (let c = 0; c < w; c++) {
			const e = eleAt(r, c);
			ele[r * w + c] = e;
			if (e < minEle) minEle = e;
			if (e > maxEle) maxEle = e;
		}
	}
	return { w, h, bbox, ele, minEle, maxEle };
}

// ~11 km × ~11 km grid at lat 0 (cos lat = 1 keeps the mental math easy):
// 11 columns/rows of vertices → 10 cells of ~1.1 km.
const BBOX = { minLat: -0.05, maxLat: 0.05, minLon: -0.05, maxLon: 0.05 };

const pt = (lat: number, lon: number, ele: number, cumDistM: number) => ({
	lat,
	lon,
	ele,
	cumDistM
});

describe('computeVisibility', () => {
	it('flat terrain hides nothing at any pose', () => {
		const grid = makeGrid(11, 11, BBOX, () => 0);
		const points = [pt(0, -0.01, 10, 0), pt(0, 0, 10, 1000), pt(0, 0.01, 10, 2000)];
		for (const pitch of [0, 0.3, 1.0, 1.5]) {
			for (const yaw of [0, 1.1, Math.PI, 4.4]) {
				expect(computeVisibility(points, grid, { yaw, pitch, zExaggeration: 3 })).toEqual([
					true,
					true,
					true
				]);
			}
		}
	});

	it('a distant wall toward the camera hides the route at grazing pitch only', () => {
		// Wall: the southern three vertex rows at 1000 m, rest at 0. At
		// yaw 0 the camera is to the SOUTH (toward-camera = (0, −1)).
		const grid = makeGrid(11, 11, BBOX, (r) => (r >= 8 ? 1000 : 0));
		const points = [pt(0.02, 0, 10, 0), pt(0.02, 0.005, 10, 500), pt(0.02, 0.01, 10, 1000)];
		// Grazing view from the south: the ray barely climbs — hidden.
		const grazing = computeVisibility(points, grid, { yaw: 0, pitch: 1.45, zExaggeration: 1 });
		expect(grazing).toEqual([false, false, false]);
		// Steep look-down: the ray outclimbs the wall long before it — visible.
		const steep = computeVisibility(points, grid, { yaw: 0, pitch: 0.3, zExaggeration: 1 });
		expect(steep).toEqual([true, true, true]);
		// Viewed from the north instead (yaw π): the march heads away from
		// the wall — visible even at grazing pitch.
		const behind = computeVisibility(points, grid, { yaw: Math.PI, pitch: 1.45, zExaggeration: 1 });
		expect(behind).toEqual([true, true, true]);
	});

	it('a route on its camera-facing slope is never hidden by its own hillside', () => {
		// Uniform slope descending toward the camera (south, yaw 0): north
		// high, south low. Along the view ray the terrain falls while the
		// ray climbs, so a route floating 10 m above the face stays visible
		// at any pitch and exaggeration — the painter-era "supporting-slope
		// burial" must not exist in the ray test.
		const grid = makeGrid(11, 11, BBOX, (r) => (10 - r) * 100);
		// Ground at the route's latitude (linear in lat at the equator):
		// lat 0.05 → 1000 m, lat −0.05 → 0 m.
		const groundAt = (lat: number) => ((lat + 0.05) / 0.1) * 1000;
		const points = [
			pt(0.01, -0.005, groundAt(0.01) + 10, 0),
			pt(0.01, 0.005, groundAt(0.01) + 10, 1000)
		];
		for (const zExaggeration of [1, 3]) {
			for (const pitch of [0.3, 1.0, 1.45]) {
				expect(computeVisibility(points, grid, { yaw: 0, pitch, zExaggeration })).toEqual([
					true,
					true
				]);
			}
		}
	});

	it('a real ridge just beyond the near skip occludes at grazing pitch', () => {
		// Thin 800 m crest at row 6 (lat −0.01); route ~2.8 km north of it,
		// well beyond the ~one-cell skip, 10 m above flat ground.
		const grid = makeGrid(11, 11, BBOX, (r) => (r === 6 ? 800 : 0));
		const cam = { yaw: 0, pitch: 1.45, zExaggeration: 1 };
		const mask = computeVisibility([pt(0.015, 0, 10, 0), pt(0.015, 0.005, 10, 500)], grid, cam);
		expect(mask).toEqual([false, false]);
	});

	it('top-down (pitch 0) is always fully visible', () => {
		const grid = makeGrid(11, 11, BBOX, (r) => (r >= 6 ? 1000 : 0));
		const points = [pt(0.02, 0, 10, 0), pt(0.02, 0.01, 10, 1000)];
		expect(computeVisibility(points, grid, { yaw: 0, pitch: 0, zExaggeration: 3 })).toEqual([
			true,
			true
		]);
	});
});

describe('smoothVisibility', () => {
	// Points 100 m apart.
	const pts = (n: number) => Array.from({ length: n }, (_, i) => pt(0, 0, 0, i * 100));

	it('absorbs a short hidden island inside a visible stretch', () => {
		const mask = [true, true, false, true, true];
		expect(smoothVisibility(mask, pts(5), 150)).toEqual([true, true, true, true, true]);
	});

	it('absorbs a short visible glimpse inside a hidden stretch', () => {
		const mask = [false, false, true, false, false];
		expect(smoothVisibility(mask, pts(5), 150)).toEqual([false, false, false, false, false]);
	});

	it('keeps islands longer than the threshold', () => {
		const mask = [true, false, false, false, false, true];
		// Hidden island spans 400 m > 150 m — stays.
		expect(smoothVisibility(mask, pts(6), 150)).toEqual(mask);
	});

	it('never flips runs touching the route ends', () => {
		const mask = [false, true, true, true, true, false];
		expect(smoothVisibility(mask, pts(6), 150)).toEqual(mask);
	});
});

describe('visibleAtDist', () => {
	const points = [pt(0, 0, 0, 0), pt(0, 0, 0, 500), pt(0, 0, 0, 1000)];

	it('returns the mask value of the first point at or beyond the distance', () => {
		const mask = [true, false, true];
		expect(visibleAtDist(points, mask, 0)).toBe(true);
		expect(visibleAtDist(points, mask, 300)).toBe(false);
		expect(visibleAtDist(points, mask, 500)).toBe(false);
		expect(visibleAtDist(points, mask, 900)).toBe(true);
		expect(visibleAtDist(points, mask, 2000)).toBe(true);
	});

	it('defaults to visible with no points', () => {
		expect(visibleAtDist([], [], 100)).toBe(true);
	});
});
