// DEM (elevation) grid for the segment topo view's terrain ground.
//
// Pure functions (terrarium decode, grid sizing, pixel sampling, bilinear
// lookup, hillshade) live here next to the DOM-touching `buildDemGrid`,
// which fetches terrarium tiles and samples them into a vertex grid —
// mirroring the tiles.ts convention (`buildDemGrid` is the only DOM-touching
// function in this module).
//
// Grid rows are uniform in MERCATOR y (not latitude), matching the ground
// texture's pixel rows: vertex (r, c) sits at exactly UV
// (c/(w-1), r/(h-1)) in the Mercator-cropped texture image, which is what
// makes the terrain mesh's texture mapping a simple linear correspondence.

import { M_PER_DEG } from './projection.js';
import { latToTileY, lonToTileX, pickTileZoom, TILE_SIZE, type TileBBox } from './tiles.js';

// AWS Open Data terrarium tiles (Mapzen/Joerd) — same trial source as the
// route map's MapLibre terrain; swap for the self-hosted archive later.
export const TERRARIUM_URL =
	'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_MAX_ZOOM = 13;
// A DEM grid is coarse (~24 cells across); 2 tiles per axis (≤ ~9 fetches
// after floor/ceil) gives far more resolution than the mesh can show.
export const DEM_TILES_PER_AXIS = 2;
// Mesh density: cells along the longer Mercator axis.
export const GRID_CELLS_LONG = 24;
export const GRID_CELLS_MIN = 4;

// Hillshade light: sun in the NW at 45° altitude (cartographic convention).
export const SHADE_AZIMUTH_RAD = (315 * Math.PI) / 180;
export const SHADE_ALTITUDE_RAD = Math.PI / 4;

export type DemGrid = {
	w: number; // vertex columns (cells = w - 1)
	h: number; // vertex rows (cells = h - 1)
	bbox: TileBBox; // identical to the ground texture bbox
	ele: Float32Array; // row-major, row 0 = maxLat (image top)
	minEle: number;
	maxEle: number;
};

// ele = R*256 + G + B/256 − 32768 (terrarium encoding).
export function decodeTerrarium(r: number, g: number, b: number): number {
	return r * 256 + g + b / 256 - 32768;
}

// Vertex-grid dimensions whose cell aspect tracks the bbox's Mercator
// aspect: GRID_CELLS_LONG cells on the longer axis, proportional (clamped)
// on the shorter. Returns null for degenerate bboxes.
export function demGridDims(bbox: TileBBox): { w: number; h: number } | null {
	const dx = lonToTileX(bbox.maxLon, 0) - lonToTileX(bbox.minLon, 0);
	const dy = latToTileY(bbox.minLat, 0) - latToTileY(bbox.maxLat, 0);
	if (!(dx > 0) || !(dy > 0)) return null;
	const aspect = dx / dy;
	const clampCells = (n: number) =>
		Math.max(GRID_CELLS_MIN, Math.min(GRID_CELLS_LONG, Math.round(n)));
	const cellsX = aspect >= 1 ? GRID_CELLS_LONG : clampCells(GRID_CELLS_LONG * aspect);
	const cellsY = aspect >= 1 ? clampCells(GRID_CELLS_LONG / aspect) : GRID_CELLS_LONG;
	return { w: cellsX + 1, h: cellsY + 1 };
}

// Sample the composited terrarium pixels into a vertex grid. Pure: takes the
// raw RGBA pixel data plus the tile-space origin of the composite (the
// floored tile indices the canvas starts at) so vertex positions map to
// fractional pixel coordinates exactly like buildTileImage's crop math.
// Bilinear on decoded elevations (the encoding is linear, so this equals
// decoding after the lerp).
export function gridFromPixels(
	data: Uint8ClampedArray,
	imgW: number,
	imgH: number,
	bbox: TileBBox,
	zoom: number,
	tileOriginX: number,
	tileOriginY: number,
	dims: { w: number; h: number }
): DemGrid {
	const { w, h } = dims;
	const ele = new Float32Array(w * h);
	const xLeft = lonToTileX(bbox.minLon, zoom);
	const xRight = lonToTileX(bbox.maxLon, zoom);
	const yTop = latToTileY(bbox.maxLat, zoom);
	const yBot = latToTileY(bbox.minLat, zoom);

	const decodeAt = (px: number, py: number): number => {
		const i = (py * imgW + px) * 4;
		return decodeTerrarium(data[i], data[i + 1], data[i + 2]);
	};
	const sample = (fx: number, fy: number): number => {
		const cx = Math.min(Math.max(fx, 0), imgW - 1);
		const cy = Math.min(Math.max(fy, 0), imgH - 1);
		const x0 = Math.floor(cx);
		const y0 = Math.floor(cy);
		const x1 = Math.min(x0 + 1, imgW - 1);
		const y1 = Math.min(y0 + 1, imgH - 1);
		const tx = cx - x0;
		const ty = cy - y0;
		const top = decodeAt(x0, y0) * (1 - tx) + decodeAt(x1, y0) * tx;
		const bot = decodeAt(x0, y1) * (1 - tx) + decodeAt(x1, y1) * tx;
		return top * (1 - ty) + bot * ty;
	};

	let minEle = Infinity;
	let maxEle = -Infinity;
	for (let r = 0; r < h; r++) {
		const my = yTop + ((yBot - yTop) * r) / (h - 1);
		const fy = (my - tileOriginY) * TILE_SIZE;
		for (let c = 0; c < w; c++) {
			const mx = xLeft + ((xRight - xLeft) * c) / (w - 1);
			const fx = (mx - tileOriginX) * TILE_SIZE;
			const e = sample(fx, fy);
			ele[r * w + c] = e;
			if (e < minEle) minEle = e;
			if (e > maxEle) maxEle = e;
		}
	}
	return { w, h, bbox, ele, minEle, maxEle };
}

// Elevation lookup at (lat, lon), clamped to the grid. The row coordinate
// goes through Mercator (rows are Mercator-uniform). Interpolation is over
// the TRIANGULATED cell surface — the same NE–SW diagonal split the terrain
// mesh renders (terrain.ts cellTriangles) — NOT bilinear: inside a cell the
// two differ by up to a quarter of the cross-diagonal elevation difference,
// and the visibility test must see exactly the surface that's drawn.
export function demEleAt(grid: DemGrid, lat: number, lon: number): number {
	const { w, h, bbox, ele } = grid;
	const yTop = latToTileY(bbox.maxLat, 0);
	const yBot = latToTileY(bbox.minLat, 0);
	const u = ((lon - bbox.minLon) / (bbox.maxLon - bbox.minLon)) * (w - 1);
	const v = ((latToTileY(lat, 0) - yTop) / (yBot - yTop)) * (h - 1);
	const cu = Math.min(Math.max(u, 0), w - 1);
	const cv = Math.min(Math.max(v, 0), h - 1);
	let c0 = Math.floor(cu);
	let r0 = Math.floor(cv);
	if (c0 >= w - 1) c0 = w - 2 >= 0 ? w - 2 : 0;
	if (r0 >= h - 1) r0 = h - 2 >= 0 ? h - 2 : 0;
	const c1 = Math.min(c0 + 1, w - 1);
	const r1 = Math.min(r0 + 1, h - 1);
	const a = cu - c0; // 0 at west edge, 1 at east
	const b = cv - r0; // 0 at north edge, 1 at south
	const zNW = ele[r0 * w + c0];
	const zNE = ele[r0 * w + c1];
	const zSW = ele[r1 * w + c0];
	const zSE = ele[r1 * w + c1];
	// Diagonal NE–SW (a + b = 1) matches terrain.ts's cell split.
	if (a + b <= 1) {
		return zNW + a * (zNE - zNW) + b * (zSW - zNW);
	}
	return zSE * (a + b - 1) + zNE * (1 - b) + zSW * (1 - a);
}

// Lambert hillshade per CELL ((w-1)×(h-1) values in [0, 1]), normalized so
// flat ground is exactly 1 — the bake multiplies this over the ground
// texture, so values only ever darken (slopes facing away from the light)
// and flat terrain keeps its original colors. Real-world meters (no
// zExaggeration): the shading is baked into the texture once, independent
// of the camera.
export function computeShade(
	grid: DemGrid,
	azimuthRad = SHADE_AZIMUTH_RAD,
	altitudeRad = SHADE_ALTITUDE_RAD
): Float32Array {
	const { w, h, bbox, ele } = grid;
	const cellsX = w - 1;
	const cellsY = h - 1;
	const out = new Float32Array(cellsX * cellsY);

	const centerLat = (bbox.minLat + bbox.maxLat) / 2;
	const cosLat = Math.cos((centerLat * Math.PI) / 180);
	const cellWm = ((bbox.maxLon - bbox.minLon) * cosLat * M_PER_DEG) / cellsX;
	// Rows are Mercator-uniform; the lat span per row varies slightly, but at
	// segment scale a uniform average is well within hillshade tolerance.
	const cellHm = ((bbox.maxLat - bbox.minLat) * M_PER_DEG) / cellsY;

	// Unit vector toward the sun (x east, y north, z up); azimuth clockwise
	// from north.
	const lx = Math.sin(azimuthRad) * Math.cos(altitudeRad);
	const ly = Math.cos(azimuthRad) * Math.cos(altitudeRad);
	const lz = Math.sin(altitudeRad);

	for (let r = 0; r < cellsY; r++) {
		for (let c = 0; c < cellsX; c++) {
			const z00 = ele[r * w + c];
			const z01 = ele[r * w + c + 1];
			const z10 = ele[(r + 1) * w + c];
			const z11 = ele[(r + 1) * w + c + 1];
			const dzdx = (z01 + z11 - z00 - z10) / 2 / cellWm;
			// Row 0 is north; northward elevation change is row r minus row r+1.
			const dzdy = (z00 + z01 - z10 - z11) / 2 / cellHm;
			// Surface normal of z = f(x, y): (-dz/dx, -dz/dy, 1) normalized.
			const nLen = Math.hypot(dzdx, dzdy, 1);
			const dot = (-dzdx * lx - dzdy * ly + lz) / nLen;
			out[r * cellsX + c] = Math.min(1, Math.max(0, dot / lz));
		}
	}
	return out;
}

// Fetch the terrarium tile grid covering `bbox`, composite onto a canvas,
// and sample into a DemGrid. Returns null when nothing loads (offline /
// blocked) so the caller can fall back to the flat ground.
//
// DOM-touching: needs `document`, `Image` and a 2D canvas. Run only in the
// browser (the segment/explore pages are `ssr = false`).
export async function buildDemGrid(bbox: TileBBox): Promise<DemGrid | null> {
	const dims = demGridDims(bbox);
	if (!dims) return null;
	const zoom = pickTileZoom(bbox, TERRARIUM_MAX_ZOOM, DEM_TILES_PER_AXIS);
	const xMin = Math.floor(lonToTileX(bbox.minLon, zoom));
	const xMax = Math.ceil(lonToTileX(bbox.maxLon, zoom));
	const yMin = Math.floor(latToTileY(bbox.maxLat, zoom));
	const yMax = Math.ceil(latToTileY(bbox.minLat, zoom));

	const w = (xMax - xMin) * TILE_SIZE;
	const h = (yMax - yMin) * TILE_SIZE;
	if (w <= 0 || h <= 0) return null;

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	// Terrarium-encoded 0 m — NOT a UI grey, which would decode failed tiles
	// to a ≈ +30 km elevation spike.
	ctx.fillStyle = 'rgb(128,0,0)';
	ctx.fillRect(0, 0, w, h);

	let loaded = 0;
	const loads: Promise<void>[] = [];
	for (let x = xMin; x < xMax; x++) {
		for (let y = yMin; y < yMax; y++) {
			const url = TERRARIUM_URL.replace('{z}', String(zoom))
				.replace('{x}', String(x))
				.replace('{y}', String(y));
			const img = new Image();
			img.crossOrigin = 'anonymous';
			const px = (x - xMin) * TILE_SIZE;
			const py = (y - yMin) * TILE_SIZE;
			loads.push(
				new Promise<void>((resolve) => {
					img.onload = () => {
						ctx.drawImage(img, px, py);
						loaded++;
						resolve();
					};
					img.onerror = () => resolve(); // missing tiles stay at 0 m
					img.src = url;
				})
			);
		}
	}
	await Promise.all(loads);
	if (loaded === 0) return null;

	const data = ctx.getImageData(0, 0, w, h).data;
	return gridFromPixels(data, w, h, bbox, zoom, xMin, yMin, dims);
}
