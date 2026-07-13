import { describe, it, expect } from 'vitest';
import {
	computeShade,
	decodeTerrarium,
	demEleAt,
	demGridDims,
	gridFromPixels,
	GRID_CELLS_LONG,
	GRID_CELLS_MIN,
	type DemGrid
} from './dem.js';
import { latToTileY, lonToTileX, TILE_SIZE } from './tiles.js';

// Build a synthetic grid directly (bypassing pixels) for sampling/shade tests.
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

const BBOX = { minLat: 45, maxLat: 45.1, minLon: 6, maxLon: 6.2 };

describe('decodeTerrarium', () => {
	it('decodes the encoded zero (128, 0, 0) to 0 m', () => {
		expect(decodeTerrarium(128, 0, 0)).toBe(0);
	});

	it('decodes known values', () => {
		// 1000 m: 33768 = 131*256 + 232
		expect(decodeTerrarium(131, 232, 0)).toBe(1000);
		// negative elevation
		expect(decodeTerrarium(127, 156, 0)).toBe(-100);
	});

	it('the blue channel adds 1/256 m steps', () => {
		expect(decodeTerrarium(128, 0, 128)).toBeCloseTo(0.5, 10);
	});
});

describe('demGridDims', () => {
	it('returns null for degenerate bboxes', () => {
		expect(demGridDims({ minLat: 45, maxLat: 45, minLon: 6, maxLon: 6.2 })).toBeNull();
		expect(demGridDims({ minLat: 45, maxLat: 45.1, minLon: 6, maxLon: 6 })).toBeNull();
	});

	it('puts GRID_CELLS_LONG cells on the longer axis', () => {
		const wide = demGridDims({ minLat: 45, maxLat: 45.1, minLon: 6, maxLon: 6.6 })!;
		expect(wide.w).toBe(GRID_CELLS_LONG + 1);
		expect(wide.h).toBeLessThanOrEqual(GRID_CELLS_LONG + 1);
		const tall = demGridDims({ minLat: 45, maxLat: 46, minLon: 6, maxLon: 6.1 })!;
		expect(tall.h).toBe(GRID_CELLS_LONG + 1);
		expect(tall.w).toBeLessThanOrEqual(GRID_CELLS_LONG + 1);
	});

	it('floors the short axis at GRID_CELLS_MIN cells', () => {
		const sliver = demGridDims({ minLat: 45, maxLat: 45.0001, minLon: 5, maxLon: 7 })!;
		expect(sliver.h).toBe(GRID_CELLS_MIN + 1);
	});
});

describe('gridFromPixels', () => {
	it('recovers a linear west-east elevation ramp from synthetic pixels', () => {
		// One-tile image whose pixel columns encode ele = column (in meters).
		const imgW = TILE_SIZE;
		const imgH = TILE_SIZE;
		const data = new Uint8ClampedArray(imgW * imgH * 4);
		for (let y = 0; y < imgH; y++) {
			for (let x = 0; x < imgW; x++) {
				const ele = x + 32768;
				const i = (y * imgW + x) * 4;
				data[i] = Math.floor(ele / 256);
				data[i + 1] = ele % 256;
				data[i + 2] = 0;
				data[i + 3] = 255;
			}
		}
		// bbox spanning the middle half of the tile at zoom 0 tile (0,0):
		const zoom = 0;
		const bbox = {
			minLon: -90, // tile x 0.25
			maxLon: 90, // tile x 0.75
			maxLat: 66.51326, // tile y ≈ 0.25
			minLat: -66.51326 // tile y ≈ 0.75
		};
		const grid = gridFromPixels(data, imgW, imgH, bbox, zoom, 0, 0, { w: 5, h: 5 });
		// West edge: pixel x = 0.25*256 = 64 → 64 m; east edge 192 m.
		expect(grid.ele[0]).toBeCloseTo(64, 3);
		expect(grid.ele[4]).toBeCloseTo(192, 3);
		// Halfway across: 128 m, on every row (ramp has no north-south slope).
		expect(grid.ele[2]).toBeCloseTo(128, 3);
		expect(grid.ele[4 * 5 + 2]).toBeCloseTo(128, 3);
		expect(grid.minEle).toBeCloseTo(64, 3);
		expect(grid.maxEle).toBeCloseTo(192, 3);
	});
});

describe('demEleAt', () => {
	it('returns exact values at grid vertices', () => {
		const grid = makeGrid(3, 3, BBOX, (r, c) => r * 100 + c * 10);
		expect(demEleAt(grid, BBOX.maxLat, BBOX.minLon)).toBeCloseTo(0, 6); // row 0 = maxLat
		expect(demEleAt(grid, BBOX.maxLat, BBOX.maxLon)).toBeCloseTo(20, 6);
		expect(demEleAt(grid, BBOX.minLat, BBOX.minLon)).toBeCloseTo(200, 6);
	});

	it('interpolates bilinearly between columns', () => {
		const grid = makeGrid(3, 2, BBOX, (_r, c) => c * 100);
		const midLon = (BBOX.minLon + BBOX.maxLon) / 2;
		expect(demEleAt(grid, BBOX.maxLat, midLon)).toBeCloseTo(100, 6);
		const quarterLon = BBOX.minLon + (BBOX.maxLon - BBOX.minLon) * 0.25;
		expect(demEleAt(grid, BBOX.maxLat, quarterLon)).toBeCloseTo(50, 6);
	});

	it('maps rows through Mercator, not linear latitude', () => {
		// Tall bbox so Mercator vs linear-lat visibly differ at the midpoint.
		const bbox = { minLat: 40, maxLat: 60, minLon: 6, maxLon: 6.2 };
		const grid = makeGrid(2, 3, bbox, (r) => r * 100); // 0 north, 200 south
		const midLat = 50;
		const yTop = latToTileY(bbox.maxLat, 0);
		const yBot = latToTileY(bbox.minLat, 0);
		const vMerc = ((latToTileY(midLat, 0) - yTop) / (yBot - yTop)) * 2;
		expect(demEleAt(grid, midLat, 6.1)).toBeCloseTo(vMerc * 100, 4);
		// And that is NOT the linear-lat answer (which would be exactly 100).
		expect(Math.abs(demEleAt(grid, midLat, 6.1) - 100)).toBeGreaterThan(1);
	});

	it('clamps outside the bbox', () => {
		const grid = makeGrid(2, 2, BBOX, (r, c) => r * 100 + c * 10);
		expect(demEleAt(grid, BBOX.maxLat + 1, BBOX.minLon - 1)).toBeCloseTo(0, 6);
		expect(demEleAt(grid, BBOX.minLat - 1, BBOX.maxLon + 1)).toBeCloseTo(110, 6);
	});
});

describe('computeShade', () => {
	it('is exactly 1 everywhere on flat terrain', () => {
		const grid = makeGrid(5, 4, BBOX, () => 500);
		const shade = computeShade(grid);
		expect(shade.length).toBe(4 * 3);
		for (const s of shade) expect(s).toBeCloseTo(1, 10);
	});

	it('lights NW-facing slopes brighter than SE-facing with the default light', () => {
		// West-facing ramp (high in the east): normal points west toward the
		// NW light → brighter than the mirrored east-facing ramp.
		const westFacing = makeGrid(5, 4, BBOX, (_r, c) => c * 200);
		const eastFacing = makeGrid(5, 4, BBOX, (_r, c) => (4 - c) * 200);
		const sw = computeShade(westFacing);
		const se = computeShade(eastFacing);
		expect(sw[0]).toBeGreaterThan(se[0]);
		// Facing away from the light must darken below flat.
		expect(sw[0]).toBeLessThanOrEqual(1);
		expect(se[0]).toBeLessThan(1);
	});

	it('never exceeds 1 (multiply bake can only darken)', () => {
		const grid = makeGrid(6, 6, BBOX, (r, c) => Math.sin(r * 2.1) * Math.cos(c * 1.7) * 400);
		for (const s of computeShade(grid)) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(1);
		}
	});
});

describe('grid UV invariant', () => {
	it('vertex (r, c) lies at UV (c/(w-1), r/(h-1)) in Mercator space', () => {
		// The reason rows are Mercator-uniform: a vertex's Mercator position
		// interpolates linearly with its row index, matching texture pixels.
		const bbox = { minLat: 44, maxLat: 46, minLon: 5, maxLon: 7 };
		const dims = demGridDims(bbox)!;
		const yTop = latToTileY(bbox.maxLat, 0);
		const yBot = latToTileY(bbox.minLat, 0);
		for (let r = 0; r < dims.h; r++) {
			const my = yTop + ((yBot - yTop) * r) / (dims.h - 1);
			const v = (my - yTop) / (yBot - yTop);
			expect(v).toBeCloseTo(r / (dims.h - 1), 12);
		}
		const xLeft = lonToTileX(bbox.minLon, 0);
		const xRight = lonToTileX(bbox.maxLon, 0);
		for (let c = 0; c < dims.w; c++) {
			const mx = xLeft + ((xRight - xLeft) * c) / (dims.w - 1);
			const u = (mx - xLeft) / (xRight - xLeft);
			expect(u).toBeCloseTo(c / (dims.w - 1), 12);
		}
	});
});
