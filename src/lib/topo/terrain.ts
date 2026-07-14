// Terrain mesh math for the segment topo view: texture-mapped heightfield
// built from a DemGrid. 100% pure — the component renders the results as
// clipped <use> elements of the single ground texture.
//
// Texture mapping: each grid cell splits into two triangles (heightfield
// cells are non-planar, and per-triangle affines agree exactly along shared
// edges, so the texture never cracks between cells). The SOURCE triangles
// live in the texture's UV space [0,1]² and are static per grid — they
// become <clipPath> defs, dilated slightly to close anti-aliasing seams.
// Per frame, only the per-triangle affine transforms (UV → screen) change.

import type { Projector } from './projection.js';
import type { RefFrame } from './projection.js';
import { latToTileY, tileYToLat, type TileBBox } from './tiles.js';
import type { DemGrid } from './dem.js';

// Source-triangle dilation factor about the centroid. Adjacent clipped
// triangles are anti-aliased independently, which leaves hairline seams;
// a ~3% overlap (≈ 0.5 px at typical cell screen size) hides them. The
// dilation lives only in the clip paths — the affines are defined by the
// exact (undilated) vertices.
export const TRI_DILATE = 1.03;

export type TriTransform = {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
};

type P2 = readonly [number, number];

// Exact affine mapping three source points to three destination points
// (SVG matrix(a b c d e f) convention: x' = a·x + c·y + e). Null when the
// source triangle is degenerate.
export function affineFromTriangle(
	src: readonly [P2, P2, P2],
	dst: readonly [P2, P2, P2]
): TriTransform | null {
	const d1x = src[1][0] - src[0][0];
	const d1y = src[1][1] - src[0][1];
	const d2x = src[2][0] - src[0][0];
	const d2y = src[2][1] - src[0][1];
	const det = d1x * d2y - d2x * d1y;
	if (Math.abs(det) < 1e-12) return null;
	const D1x = dst[1][0] - dst[0][0];
	const D1y = dst[1][1] - dst[0][1];
	const D2x = dst[2][0] - dst[0][0];
	const D2y = dst[2][1] - dst[0][1];
	const a = (D1x * d2y - D2x * d1y) / det;
	const c = (D2x * d1x - D1x * d2x) / det;
	const b = (D1y * d2y - D2y * d1y) / det;
	const d = (D2y * d1x - D1y * d2x) / det;
	const e = dst[0][0] - (a * src[0][0] + c * src[0][1]);
	const f = dst[0][1] - (b * src[0][0] + d * src[0][1]);
	return { a, b, c, d, e, f };
}

// Latitude of grid row r (rows are Mercator-uniform, row 0 = maxLat) and
// longitude of grid column c.
export function gridRowLat(grid: DemGrid, r: number): number {
	const yTop = latToTileY(grid.bbox.maxLat, 0);
	const yBot = latToTileY(grid.bbox.minLat, 0);
	return tileYToLat(yTop + ((yBot - yTop) * r) / (grid.h - 1), 0);
}
export function gridColLon(grid: DemGrid, c: number): number {
	return grid.bbox.minLon + ((grid.bbox.maxLon - grid.bbox.minLon) * c) / (grid.w - 1);
}

// UV corners of cell (r, c) — matches gridFromPixels' vertex placement.
function cellUV(cellsX: number, cellsY: number, r: number, c: number) {
	const u0 = c / cellsX;
	const u1 = (c + 1) / cellsX;
	const v0 = r / cellsY;
	const v1 = (r + 1) / cellsY;
	// NW, NE, SW, SE
	return [
		[u0, v0],
		[u1, v0],
		[u0, v1],
		[u1, v1]
	] as const;
}

// Cell (r, c) splits on the NE–SW diagonal into triangle 2·i = (NW, NE, SW)
// and 2·i + 1 = (NE, SE, SW), where i = r·cellsX + c.
function cellTriangles(cellsX: number, cellsY: number, r: number, c: number): [P2, P2, P2][] {
	const [nw, ne, sw, se] = cellUV(cellsX, cellsY, r, c);
	return [
		[nw, ne, sw],
		[ne, se, sw]
	];
}

// Static clip triangles in UV space, dilated about their centroids —
// the canvas painter's clip regions. Index i corresponds 1:1 with
// buildTerrainMesh's transforms.
export type ClipTriangle = [P2, P2, P2];

export function buildClipTriangles(
	cellsX: number,
	cellsY: number,
	dilate = TRI_DILATE
): ClipTriangle[] {
	const out: ClipTriangle[] = [];
	for (let r = 0; r < cellsY; r++) {
		for (let c = 0; c < cellsX; c++) {
			for (const tri of cellTriangles(cellsX, cellsY, r, c)) {
				const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
				const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
				const [p0, p1, p2] = tri.map(
					([x, y]): P2 => [cx + (x - cx) * dilate, cy + (y - cy) * dilate]
				);
				out.push([p0, p1, p2]);
			}
		}
	}
	return out;
}

// Per-frame UV → screen affines, one per triangle, index-aligned with
// buildClipTriangles. Projects each grid vertex once; null entries mark
// degenerate (edge-on) triangles the template should skip.
export function buildTerrainMesh(grid: DemGrid, project: Projector): (TriTransform | null)[] {
	const { w, h, ele } = grid;
	const cellsX = w - 1;
	const cellsY = h - 1;

	const px = new Float64Array(w * h);
	const py = new Float64Array(w * h);
	for (let r = 0; r < h; r++) {
		const lat = gridRowLat(grid, r);
		for (let c = 0; c < w; c++) {
			const [x, y] = project(lat, gridColLon(grid, c), ele[r * w + c]);
			px[r * w + c] = x;
			py[r * w + c] = y;
		}
	}

	const out: (TriTransform | null)[] = [];
	const P = (r: number, c: number): P2 => [px[r * w + c], py[r * w + c]];
	for (let r = 0; r < cellsY; r++) {
		for (let c = 0; c < cellsX; c++) {
			const [uvNW, uvNE, uvSW, uvSE] = cellUV(cellsX, cellsY, r, c);
			const nw = P(r, c);
			const ne = P(r, c + 1);
			const sw = P(r + 1, c);
			const se = P(r + 1, c + 1);
			out.push(affineFromTriangle([uvNW, uvNE, uvSW], [nw, ne, sw]));
			out.push(affineFromTriangle([uvNE, uvSE, uvSW], [ne, se, sw]));
		}
	}
	return out;
}

// Painter order for the mesh triangles: back-to-front nested traversal
// derived from the yaw quadrant. For an orthographic heightfield, two cells
// can only occlude each other when they overlap in screen x, and under that
// constraint depth order reduces to row order (column order when facing
// sideways) — so sweeping rows/columns in the right directions is a correct
// painter order. Ground depth ≈ −(x·sin(yaw) + y·cos(yaw))·sin(pitch), so
// "far first" = descending (x·sinYaw + y·cosYaw); columns run east (+x)
// with c, rows run south (−y) with r.
//
// Returns one of four CACHED arrays (keyed on the yaw signs), so the keyed
// {#each} only reorders the DOM when yaw crosses a quadrant boundary.
const orderCache = new Map<string, readonly number[]>();

export function terrainDrawOrder(cellsX: number, cellsY: number, yaw: number): readonly number[] {
	const sinPos = Math.sin(yaw) >= 0;
	const cosPos = Math.cos(yaw) >= 0;
	const key = `${cellsX}x${cellsY}:${sinPos ? 1 : 0}${cosPos ? 1 : 0}`;
	const cached = orderCache.get(key);
	if (cached) return cached;

	const order: number[] = [];
	// cos(yaw) > 0 → far = north = row 0 first; else south first.
	// sin(yaw) > 0 → far = east = last column first; else first column first.
	for (let i = 0; i < cellsY; i++) {
		const r = cosPos ? i : cellsY - 1 - i;
		for (let j = 0; j < cellsX; j++) {
			const c = sinPos ? cellsX - 1 - j : j;
			const cell = r * cellsX + c;
			order.push(cell * 2, cell * 2 + 1);
		}
	}
	orderCache.set(key, order);
	return order;
}

export type TerrainFace = {
	// Also used for screen-space containment tests (the ghost pass needs
	// to know which route points a front wall covers — the walls aren't
	// terrain, so the visibility mask can't).
	verts: [number, number][];
	depth: number;
	isFront: boolean;
};

// The four "earth block" side faces under a terrain mesh: top edge follows
// the DEM boundary profile, bottom sits blockDepthM below the lowest of the
// grid and the route. isFront marks faces whose outward side points toward
// the viewer — the component draws back faces before the mesh and front
// faces after it, so a far valley can't bleed through the near silhouette.
export function buildTerrainBlockFaces(
	grid: DemGrid,
	refFrame: RefFrame | null,
	project: Projector,
	blockDepthM: number
): TerrainFace[] {
	if (!refFrame) return [];
	const { w, h, ele, bbox } = grid;
	const base = Math.min(grid.minEle, refFrame.minEle) - blockDepthM;

	const centerLat = (bbox.minLat + bbox.maxLat) / 2;
	const centerLon = (bbox.minLon + bbox.maxLon) / 2;
	const latSpan = bbox.maxLat - bbox.minLat;
	const lonSpan = bbox.maxLon - bbox.minLon;

	type Edge = {
		// vertex (lat, lon, ele) walker along the face's top profile
		count: number;
		at: (i: number) => [number, number, number];
		// outward direction in (lat, lon)
		outLat: number;
		outLon: number;
	};
	const edges: Edge[] = [
		{
			// north: row 0, west → east
			count: w,
			at: (i) => [gridRowLat(grid, 0), gridColLon(grid, i), ele[i]],
			outLat: 1,
			outLon: 0
		},
		{
			// south: last row, west → east
			count: w,
			at: (i) => [gridRowLat(grid, h - 1), gridColLon(grid, i), ele[(h - 1) * w + i]],
			outLat: -1,
			outLon: 0
		},
		{
			// west: col 0, north → south
			count: h,
			at: (i) => [gridRowLat(grid, i), gridColLon(grid, 0), ele[i * w]],
			outLat: 0,
			outLon: -1
		},
		{
			// east: last col, north → south
			count: h,
			at: (i) => [gridRowLat(grid, i), gridColLon(grid, w - 1), ele[i * w + w - 1]],
			outLat: 0,
			outLon: 1
		}
	];

	const out: TerrainFace[] = [];
	for (const edge of edges) {
		const verts: [number, number][] = [];
		let depthSum = 0;
		let first: [number, number, number] | null = null;
		let last: [number, number, number] | null = null;
		for (let i = 0; i < edge.count; i++) {
			const [lat, lon, e] = edge.at(i);
			if (i === 0) first = [lat, lon, e];
			last = [lat, lon, e];
			const [x, y, d] = project(lat, lon, e);
			verts.push([x, y]);
			depthSum += d;
		}
		// Close the fan: down to the base under the last vertex, back under
		// the first.
		const [lx, ly, ld] = project(last![0], last![1], base);
		const [fx, fy, fd] = project(first![0], first![1], base);
		verts.push([lx, ly], [fx, fy]);
		depthSum += ld + fd;

		// Front/back: nudge the face's center outward (in lat/lon) and see
		// whether it moves toward the viewer (larger depth = closer).
		const midEle = (grid.minEle + grid.maxEle) / 2;
		const faceLat = edge.outLat !== 0 ? centerLat + (edge.outLat * latSpan) / 2 : centerLat;
		const faceLon = edge.outLon !== 0 ? centerLon + (edge.outLon * lonSpan) / 2 : centerLon;
		const [, , d0] = project(faceLat, faceLon, midEle);
		const [, , d1] = project(
			faceLat + edge.outLat * latSpan * 0.01,
			faceLon + edge.outLon * lonSpan * 0.01,
			midEle
		);
		out.push({
			verts,
			depth: depthSum / (edge.count + 2),
			isFront: d1 > d0
		});
	}
	out.sort((a, b) => a.depth - b.depth);
	return out;
}

// Standard even-odd ray cast. Used to test route points against the
// front block-face polygons for the through-the-wall ghost.
export function pointInPolygon(
	x: number,
	y: number,
	verts: readonly (readonly [number, number])[]
): boolean {
	let inside = false;
	for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
		const [xi, yi] = verts[i];
		const [xj, yj] = verts[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}
