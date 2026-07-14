import { describe, it, expect } from 'vitest';
import type { Projected, Projector } from './projection.js';
import { computeRefFrame } from './projection.js';
import {
	affineFromTriangle,
	buildClipTriangles,
	buildTerrainBlockFaces,
	buildTerrainMesh,
	gridColLon,
	gridRowLat,
	pointInPolygon,
	terrainDrawOrder,
	TRI_DILATE,
	type TriTransform
} from './terrain.js';
import type { DemGrid } from './dem.js';

// Same identity-style projector trick as geometry.test.ts.
const identity: Projector = (lat, lon, ele) => [lon, -lat, ele] as Projected;

function apply(t: TriTransform, x: number, y: number): [number, number] {
	return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

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

describe('affineFromTriangle', () => {
	const src: [[number, number], [number, number], [number, number]] = [
		[0, 0],
		[1, 0],
		[0, 1]
	];

	it('maps the three source points exactly onto the destinations', () => {
		const dst: [[number, number], [number, number], [number, number]] = [
			[10, 20],
			[13, 21],
			[9, 26]
		];
		const t = affineFromTriangle(src, dst)!;
		for (let i = 0; i < 3; i++) {
			const [x, y] = apply(t, src[i][0], src[i][1]);
			expect(x).toBeCloseTo(dst[i][0], 10);
			expect(y).toBeCloseTo(dst[i][1], 10);
		}
	});

	it('returns null for a degenerate (collinear) source triangle', () => {
		expect(
			affineFromTriangle(
				[
					[0, 0],
					[1, 1],
					[2, 2]
				],
				[
					[0, 0],
					[1, 0],
					[0, 1]
				]
			)
		).toBeNull();
	});
});

describe('buildClipTriangles', () => {
	it('emits two triangles per cell', () => {
		expect(buildClipTriangles(4, 3).length).toBe(24);
	});

	it('dilates each triangle about its centroid', () => {
		const [raw] = buildClipTriangles(2, 2, 1);
		const [dilated] = buildClipTriangles(2, 2, TRI_DILATE);
		const cx = (raw[0][0] + raw[1][0] + raw[2][0]) / 3;
		const cy = (raw[0][1] + raw[1][1] + raw[2][1]) / 3;
		// Same centroid, every vertex strictly farther from it.
		expect((dilated[0][0] + dilated[1][0] + dilated[2][0]) / 3).toBeCloseTo(cx, 5);
		expect((dilated[0][1] + dilated[1][1] + dilated[2][1]) / 3).toBeCloseTo(cy, 5);
		for (let i = 0; i < 3; i++) {
			const d0 = Math.hypot(raw[i][0] - cx, raw[i][1] - cy);
			const d1 = Math.hypot(dilated[i][0] - cx, dilated[i][1] - cy);
			expect(d1).toBeGreaterThan(d0);
			expect(d1 / d0).toBeCloseTo(TRI_DILATE, 3);
		}
	});
});

describe('buildTerrainMesh', () => {
	const grid = makeGrid(4, 3, BBOX, (r, c) => r * 50 + c * 10);

	it('is index-aligned with the clip triangles (two per cell)', () => {
		const mesh = buildTerrainMesh(grid, identity);
		const clips = buildClipTriangles(grid.w - 1, grid.h - 1);
		expect(mesh.length).toBe(clips.length);
		expect(mesh.length).toBe(2 * (grid.w - 1) * (grid.h - 1));
		expect(mesh.every((t) => t !== null)).toBe(true);
	});

	it('maps UV corners onto the projected grid vertices', () => {
		const mesh = buildTerrainMesh(grid, identity);
		// Triangle 0 of cell (0,0) is (NW, NE, SW); UV NW = (0,0).
		const [x, y] = apply(mesh[0]!, 0, 0);
		expect(x).toBeCloseTo(gridColLon(grid, 0), 6);
		expect(y).toBeCloseTo(-gridRowLat(grid, 0), 6);
		// Last triangle's UV SE corner = (1,1) → last grid vertex.
		const last = mesh[mesh.length - 1]!;
		const [xe, ye] = apply(last, 1, 1);
		expect(xe).toBeCloseTo(gridColLon(grid, grid.w - 1), 6);
		expect(ye).toBeCloseTo(-gridRowLat(grid, grid.h - 1), 6);
	});

	it('adjacent triangles agree on their shared edge vertices', () => {
		const mesh = buildTerrainMesh(grid, identity);
		const cellsX = grid.w - 1;
		const cellsY = grid.h - 1;
		// Within a cell: tri 2i and 2i+1 share UV NE and SW.
		for (let r = 0; r < cellsY; r++) {
			for (let c = 0; c < cellsX; c++) {
				const i = r * cellsX + c;
				const uvNE: [number, number] = [(c + 1) / cellsX, r / cellsY];
				const uvSW: [number, number] = [c / cellsX, (r + 1) / cellsY];
				for (const uv of [uvNE, uvSW]) {
					const a = apply(mesh[2 * i]!, uv[0], uv[1]);
					const b = apply(mesh[2 * i + 1]!, uv[0], uv[1]);
					expect(a[0]).toBeCloseTo(b[0], 8);
					expect(a[1]).toBeCloseTo(b[1], 8);
				}
			}
		}
	});
});

describe('terrainDrawOrder', () => {
	it('covers every triangle exactly once', () => {
		const order = terrainDrawOrder(4, 3, 0.3);
		expect(order.length).toBe(24);
		expect(new Set(order).size).toBe(24);
	});

	it('returns the same cached array within a yaw quadrant', () => {
		expect(terrainDrawOrder(4, 3, 0.1)).toBe(terrainDrawOrder(4, 3, 0.4));
		expect(terrainDrawOrder(4, 3, 0.1)).not.toBe(terrainDrawOrder(4, 3, Math.PI / 2 + 0.1));
	});

	it('draws far rows/columns first in the four canonical yaws', () => {
		const cellsX = 3;
		const cellsY = 2;
		const rowOf = (tri: number) => Math.floor(Math.floor(tri / 2) / cellsX);
		const colOf = (tri: number) => Math.floor(tri / 2) % cellsX;
		// yaw 0: facing north → north (row 0) is far, drawn first.
		expect(rowOf(terrainDrawOrder(cellsX, cellsY, 0)[0])).toBe(0);
		// yaw π: south (last row) far.
		expect(rowOf(terrainDrawOrder(cellsX, cellsY, Math.PI)[0])).toBe(cellsY - 1);
		// yaw π/2: east (last column) far.
		expect(colOf(terrainDrawOrder(cellsX, cellsY, Math.PI / 2)[0])).toBe(cellsX - 1);
		// yaw 3π/2 (sin < 0): west (column 0) far.
		expect(colOf(terrainDrawOrder(cellsX, cellsY, (3 * Math.PI) / 2)[0])).toBe(0);
	});
});

describe('buildTerrainBlockFaces', () => {
	const grid = makeGrid(4, 3, BBOX, (r, c) => 400 + r * 50 + c * 10);
	const refFrame = computeRefFrame([
		{ lat: 45.02, lon: 6.05, ele: 500 },
		{ lat: 45.08, lon: 6.15, ele: 800 }
	])!;

	it('returns four faces sorted back-to-front by depth', () => {
		// Depth = ele under the identity projector — degenerate for sorting,
		// so use a projector whose depth is -lat (north = far).
		const project: Projector = (lat, lon, ele) => [lon, ele, -lat] as Projected;
		const faces = buildTerrainBlockFaces(grid, refFrame, project, 100);
		expect(faces.length).toBe(4);
		for (let i = 1; i < faces.length; i++) {
			expect(faces[i].depth).toBeGreaterThanOrEqual(faces[i - 1].depth);
		}
	});

	it('classifies front/back by the outward-nudge depth test', () => {
		// depth = -(lat + lon): outward north or east lowers depth (back),
		// south and west raise it (front).
		const neFar: Projector = (lat, lon, ele) => [lon, ele, -(lat + lon)] as Projected;
		const faces = buildTerrainBlockFaces(grid, refFrame, neFar, 100);
		expect(faces.filter((f) => !f.isFront).length).toBe(2);
		expect(faces.filter((f) => f.isFront).length).toBe(2);
		// Flip the projector → every classification flips. Match faces
		// across the two runs by their identical vertex polygons.
		const swFar: Projector = (lat, lon, ele) => [lon, ele, lat + lon] as Projected;
		const flipped = buildTerrainBlockFaces(grid, refFrame, swFar, 100);
		const key = (f: { verts: [number, number][] }) => JSON.stringify(f.verts);
		for (let i = 0; i < 4; i++) {
			const match = flipped.find((f) => key(f) === key(faces[i]))!;
			expect(match.isFront).toBe(!faces[i].isFront);
		}
	});

	it('drops the base below both the grid and the route minimum', () => {
		// Identity projector: y = -lat unaffected by ele; use a projector that
		// exposes ele as y so we can read the base back out of the verts.
		const eleAsY: Projector = (lat, lon, ele) => [lon, ele, -lat] as Projected;
		const faces = buildTerrainBlockFaces(grid, refFrame, eleAsY, 100);
		const expectedBase = Math.min(grid.minEle, refFrame.minEle) - 100;
		// grid.minEle = 400 < refFrame.minEle = 500 → base = 300.
		expect(expectedBase).toBe(300);
		for (const face of faces) {
			const ys = face.verts.map(([, y]) => y);
			expect(Math.min(...ys)).toBeCloseTo(expectedBase, 1);
		}
	});
});

describe('pointInPolygon', () => {
	const square: [number, number][] = [
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 10]
	];

	it('classifies inside and outside points of a square', () => {
		expect(pointInPolygon(5, 5, square)).toBe(true);
		expect(pointInPolygon(-1, 5, square)).toBe(false);
		expect(pointInPolygon(11, 5, square)).toBe(false);
		expect(pointInPolygon(5, 12, square)).toBe(false);
	});

	it('handles a concave polygon (block-face-like profile)', () => {
		// A "notched wall": tall at both ends, low in the middle.
		const wall: [number, number][] = [
			[0, 10],
			[4, 10],
			[4, 4],
			[6, 4],
			[6, 10],
			[10, 10],
			[10, 0],
			[0, 0]
		];
		expect(pointInPolygon(5, 2, wall)).toBe(true); // below the notch
		expect(pointInPolygon(5, 6, wall)).toBe(false); // inside the notch
		expect(pointInPolygon(2, 8, wall)).toBe(true); // left tower
	});
});
