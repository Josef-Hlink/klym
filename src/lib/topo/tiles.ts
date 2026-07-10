// Slippy-tile fetch + composite for the segment topo view's "ground" layer.
//
// Pure functions (slippy-tile coordinate math, tile-zoom selection, padded
// bbox computation, fade opacity) live here next to the DOM-touching
// `buildTileImage`, which fetches a grid of tiles and composites them into
// a single PNG data URL. The composite is then placed in the SVG via an
// affine transform — see SegmentMap.tileTransform for that.

import { M_PER_DEG, type RefFrame } from './projection.js';

export const TILE_SIZE = 256;
export const TILE_BBOX_PAD = 0.1; // 10% lat/lon padding around the route bbox
export const TILE_MAX_TILES_PER_AXIS = 10;

// Pitch range over which the OSM ground (and earth block) fade out. By the
// time we're past TILE_FADE_END the tile is nearly edge-on and unreadable.
export const TILE_FADE_START = Math.PI / 4;
export const TILE_FADE_END = Math.PI / 2 - 0.05;

// Metres of "earth" the ground sits on — the side faces of the block drop
// this far below the OSM ground at the same lat/lon corners.
export const BLOCK_DEPTH_M = 100;

export type MapSource = 'osm' | 'topo' | 'sat' | 'proto';

// Raster sources are slippy-tile URL templates composited by buildTileImage;
// the vector source is the self-hosted Protomaps basemap, rasterized via an
// off-screen MapLibre snapshot (see vectorTile.ts) — no URL template.
export type RasterTileSource = {
	kind: 'raster';
	url: string;
	subdomains: string[] | null;
	maxZoom: number;
	label: string;
};
export type VectorTileSource = {
	kind: 'vector';
	label: string;
};
export type TileSource = RasterTileSource | VectorTileSource;

export const TILE_SOURCES: Record<MapSource, TileSource> = {
	osm: {
		kind: 'raster',
		url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
		subdomains: null,
		maxZoom: 19,
		label: 'Default'
	},
	topo: {
		kind: 'raster',
		url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
		subdomains: ['a', 'b', 'c'],
		maxZoom: 17,
		label: 'Topographical'
	},
	sat: {
		kind: 'raster',
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		subdomains: null,
		maxZoom: 19,
		label: 'Satellite'
	},
	proto: {
		kind: 'vector',
		label: 'Vector'
	}
};

export type TileBBox = {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
};

export type TileImage = TileBBox & {
	url: string;
};

// Standard slippy-tile <-> lat/lon math.
export function lonToTileX(lon: number, z: number): number {
	return ((lon + 180) / 360) * Math.pow(2, z);
}
export function latToTileY(lat: number, z: number): number {
	const r = (lat * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
}
export function tileXToLon(x: number, z: number): number {
	return (x / Math.pow(2, z)) * 360 - 180;
}
export function tileYToLat(y: number, z: number): number {
	const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// Highest zoom level that keeps the tile grid under TILE_MAX_TILES_PER_AXIS
// (so we don't fetch hundreds of tiles for a country-scale route).
export function pickTileZoom(bbox: TileBBox, maxZoom: number): number {
	for (let z = maxZoom; z >= 1; z--) {
		const xRange = lonToTileX(bbox.maxLon, z) - lonToTileX(bbox.minLon, z);
		const yRange = latToTileY(bbox.minLat, z) - latToTileY(bbox.maxLat, z);
		if (xRange <= TILE_MAX_TILES_PER_AXIS && yRange <= TILE_MAX_TILES_PER_AXIS) {
			return z;
		}
	}
	return 1;
}

// Build the padded bbox the tile fetcher should request. Returns null when
// there's not enough data (no refFrame, < 2 points). The bbox is the route
// bbox plus the larger of:
//   - basePadFraction of each lat/lon span (TILE_BBOX_PAD by default)
//   - whatever extra padding is needed to fill the canvas at `dataAspect`,
//     so a tall route in a wide canvas gets the side-letterbox area covered
//     by tiles instead of bare grey.
export function computePaddedTileBBox(
	points: readonly { lat: number; lon: number }[],
	refFrame: RefFrame | null,
	dataAspect: number,
	basePadFraction = TILE_BBOX_PAD
): TileBBox | null {
	if (!refFrame || points.length < 2) return null;
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const p of points) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lon < minLon) minLon = p.lon;
		if (p.lon > maxLon) maxLon = p.lon;
	}
	const baseLatPad = (maxLat - minLat) * basePadFraction;
	const baseLonPad = (maxLon - minLon) * basePadFraction;

	// Extend the tile bbox to cover the data-driven canvas (which may be
	// letterboxed against the route's true aspect) so the OSM image fills
	// the canvas rather than leaving bare grey margins.
	const trueAspect = refFrame.xSpanM / refFrame.ySpanM;
	const canvasXspanM =
		dataAspect > trueAspect ? dataAspect * refFrame.ySpanM : refFrame.xSpanM;
	const canvasYspanM =
		dataAspect > trueAspect ? refFrame.ySpanM : refFrame.xSpanM / dataAspect;
	const extraLonPad =
		Math.max(0, canvasXspanM - refFrame.xSpanM) / 2 / (refFrame.cosLat * M_PER_DEG);
	const extraLatPad = Math.max(0, canvasYspanM - refFrame.ySpanM) / 2 / M_PER_DEG;

	const lonPad = Math.max(baseLonPad, extraLonPad);
	const latPad = Math.max(baseLatPad, extraLatPad);
	return {
		minLat: minLat - latPad,
		maxLat: maxLat + latPad,
		minLon: minLon - lonPad,
		maxLon: maxLon + lonPad
	};
}

// Long-axis pixel cap for the vector-ground snapshot. Comparable to the
// raster path's ceiling (TILE_MAX_TILES_PER_AXIS × TILE_SIZE = 2560).
export const SNAPSHOT_MAX_PX = 2048;

// Canvas dims (CSS px) whose aspect equals the bbox's Web-Mercator aspect —
// the same projection the slippy composite is cropped in, so a snapshot at
// these dims drops into buildTileTransform like a raster composite does.
// Mercator aspect is zoom-independent; computed with the z0 tile math.
// Integer rounding of the short axis costs at most sub-pixel misregistration.
export function snapshotDims(
	bbox: TileBBox,
	maxPx = SNAPSHOT_MAX_PX
): { width: number; height: number } | null {
	const dx = lonToTileX(bbox.maxLon, 0) - lonToTileX(bbox.minLon, 0);
	const dy = latToTileY(bbox.minLat, 0) - latToTileY(bbox.maxLat, 0);
	if (!(dx > 0) || !(dy > 0)) return null;
	const aspect = dx / dy;
	return aspect >= 1
		? { width: maxPx, height: Math.max(1, Math.round(maxPx / aspect)) }
		: { width: Math.max(1, Math.round(maxPx * aspect)), height: maxPx };
}

// Camera that renders exactly `bbox` into a canvas `widthPx` wide (MapLibre's
// world is 512 × 2^zoom px). Center is the Mercator midpoint, NOT the lat
// midpoint — Mercator stretches with latitude. Explicit camera math instead
// of fitBounds: deterministic, and no padding/rounding surprises.
export function snapshotCamera(
	bbox: TileBBox,
	widthPx: number
): { center: [number, number]; zoom: number } {
	const x0 = lonToTileX(bbox.minLon, 0);
	const x1 = lonToTileX(bbox.maxLon, 0);
	const y0 = latToTileY(bbox.maxLat, 0);
	const y1 = latToTileY(bbox.minLat, 0);
	return {
		center: [tileXToLon((x0 + x1) / 2, 0), tileYToLat((y0 + y1) / 2, 0)],
		zoom: Math.log2(widthPx / (512 * (x1 - x0)))
	};
}

// Fade the tile/earth-block layer as pitch approaches edge-on. Returns 1
// while pitch is below TILE_FADE_START, ramps linearly to 0 between
// TILE_FADE_START and TILE_FADE_END.
export function tileFadeOpacity(pitch: number): number {
	if (pitch <= TILE_FADE_START) return 1;
	if (pitch >= TILE_FADE_END) return 0;
	return 1 - (pitch - TILE_FADE_START) / (TILE_FADE_END - TILE_FADE_START);
}

// Fetch the tile grid covering `bbox`, composite onto a canvas, then crop
// to the requested bbox (so edges line up with the route bbox + padding
// instead of the floor/ceil whole-tile boundary). Returns a single PNG data
// URL that can be placed under the route via an affine transform.
//
// DOM-touching: needs `document` and `Image` and a 2D canvas context. Run
// only in the browser (the segment page is `ssr = false`).
export async function buildTileImage(
	bbox: TileBBox,
	zoom: number,
	urlTemplate: string,
	subdomains: string[] | null
): Promise<TileImage | null> {
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
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = '#f4f4f5';
	ctx.fillRect(0, 0, w, h);

	const loads: Promise<void>[] = [];
	for (let x = xMin; x < xMax; x++) {
		for (let y = yMin; y < yMax; y++) {
			let url = urlTemplate;
			if (subdomains && subdomains.length) {
				const sub = subdomains[Math.abs(x + y) % subdomains.length];
				url = url.replace('{s}', sub);
			}
			url = url
				.replace('{z}', String(zoom))
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
						resolve();
					};
					img.onerror = () => resolve(); // skip missing tiles silently
					img.src = url;
				})
			);
		}
	}
	await Promise.all(loads);

	const cropX0 = Math.max(0, (lonToTileX(bbox.minLon, zoom) - xMin) * TILE_SIZE);
	const cropX1 = Math.min(w, (lonToTileX(bbox.maxLon, zoom) - xMin) * TILE_SIZE);
	const cropY0 = Math.max(0, (latToTileY(bbox.maxLat, zoom) - yMin) * TILE_SIZE);
	const cropY1 = Math.min(h, (latToTileY(bbox.minLat, zoom) - yMin) * TILE_SIZE);
	const cw = Math.round(cropX1 - cropX0);
	const ch = Math.round(cropY1 - cropY0);
	if (cw <= 0 || ch <= 0) return null;

	const cropped = document.createElement('canvas');
	cropped.width = cw;
	cropped.height = ch;
	const cctx = cropped.getContext('2d');
	if (!cctx) return null;
	cctx.drawImage(canvas, cropX0, cropY0, cw, ch, 0, 0, cw, ch);

	return {
		url: cropped.toDataURL('image/png'),
		minLon: bbox.minLon,
		maxLon: bbox.maxLon,
		maxLat: bbox.maxLat,
		minLat: bbox.minLat
	};
}
