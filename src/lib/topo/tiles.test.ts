import { describe, it, expect } from 'vitest';
import { computeRefFrame } from './projection.js';
import {
	computePaddedTileBBox,
	latToTileY,
	lonToTileX,
	pickTileZoom,
	tileFadeOpacity,
	tileXToLon,
	tileYToLat,
	TILE_FADE_END,
	TILE_FADE_START,
	TILE_MAX_TILES_PER_AXIS
} from './tiles.js';

describe('slippy tile coordinates', () => {
	it('maps (lon=0, lat=0) to the centre of the world tile at zoom 0', () => {
		expect(lonToTileX(0, 0)).toBeCloseTo(0.5, 10);
		expect(latToTileY(0, 0)).toBeCloseTo(0.5, 10);
	});

	it('zoom z splits the world into 2^z tiles per axis', () => {
		expect(lonToTileX(180, 1)).toBeCloseTo(2, 10);
		expect(lonToTileX(-180, 1)).toBeCloseTo(0, 10);
		expect(lonToTileX(180, 5)).toBeCloseTo(32, 10);
	});

	it('lonToTileX <-> tileXToLon roundtrips for a few longitudes and zooms', () => {
		for (const z of [3, 8, 14]) {
			for (const lon of [-179, -45, 0, 12.345, 100]) {
				expect(tileXToLon(lonToTileX(lon, z), z)).toBeCloseTo(lon, 6);
			}
		}
	});

	it('latToTileY <-> tileYToLat roundtrips for a few latitudes and zooms', () => {
		// Web Mercator clips near the poles, so stay within ±85°.
		for (const z of [3, 8, 14]) {
			for (const lat of [-85, -45, 0, 12.345, 60]) {
				expect(tileYToLat(latToTileY(lat, z), z)).toBeCloseTo(lat, 5);
			}
		}
	});
});

describe('pickTileZoom', () => {
	const tinyBBox = { minLat: 45, maxLat: 45.001, minLon: 5, maxLon: 5.001 };
	const hugeBBox = { minLat: -60, maxLat: 60, minLon: -180, maxLon: 180 };

	it('returns maxZoom when the bbox is so small even the highest zoom fits', () => {
		expect(pickTileZoom(tinyBBox, 19)).toBe(19);
	});

	it('keeps the resulting tile grid under TILE_MAX_TILES_PER_AXIS', () => {
		const z = pickTileZoom({ minLat: 45, maxLat: 46, minLon: 5, maxLon: 7 }, 19);
		const xRange = lonToTileX(7, z) - lonToTileX(5, z);
		const yRange = latToTileY(45, z) - latToTileY(46, z);
		expect(xRange).toBeLessThanOrEqual(TILE_MAX_TILES_PER_AXIS);
		expect(yRange).toBeLessThanOrEqual(TILE_MAX_TILES_PER_AXIS);
	});

	it('drops to a low zoom for a world-sized bbox so the grid stays under the cap', () => {
		// Global longitude span = 2^z tiles per axis at zoom z. The largest z
		// with 2^z <= 10 is 3 (8 <= 10 < 16).
		expect(pickTileZoom(hugeBBox, 19)).toBe(3);
	});

	it('returns 1 as the floor when the loop is starved (maxZoom=0)', () => {
		expect(pickTileZoom(tinyBBox, 0)).toBe(1);
	});
});

describe('computePaddedTileBBox', () => {
	const points = [
		{ lat: 45, lon: 5 },
		{ lat: 45.01, lon: 5.02 }
	];

	it('returns null when there is no refFrame or fewer than two points', () => {
		const refFrame = computeRefFrame(points.map((p) => ({ ...p, ele: 0 })))!;
		expect(computePaddedTileBBox(points, null, 2)).toBeNull();
		expect(computePaddedTileBBox(points.slice(0, 1), refFrame, 2)).toBeNull();
	});

	it('applies the base 10% pad on each axis when the canvas matches the route aspect', () => {
		const refFrame = computeRefFrame(points.map((p) => ({ ...p, ele: 0 })))!;
		const trueAspect = refFrame.xSpanM / refFrame.ySpanM;
		const out = computePaddedTileBBox(points, refFrame, trueAspect);
		expect(out).not.toBeNull();
		const latSpan = 45.01 - 45;
		const lonSpan = 5.02 - 5;
		expect(out!.minLat).toBeCloseTo(45 - latSpan * 0.1, 6);
		expect(out!.maxLat).toBeCloseTo(45.01 + latSpan * 0.1, 6);
		expect(out!.minLon).toBeCloseTo(5 - lonSpan * 0.1, 6);
		expect(out!.maxLon).toBeCloseTo(5.02 + lonSpan * 0.1, 6);
	});

	it('extends the lon pad when the canvas is wider than the route aspect', () => {
		// Force a route that's near-square so a wide canvas needs side-letterbox padding.
		const square = [
			{ lat: 45, lon: 5 },
			{ lat: 45.01, lon: 5.014 }
		];
		const refFrame = computeRefFrame(square.map((p) => ({ ...p, ele: 0 })))!;
		const wideCanvas = 3;
		const tightAspect = refFrame.xSpanM / refFrame.ySpanM;
		const tight = computePaddedTileBBox(square, refFrame, tightAspect)!;
		const wide = computePaddedTileBBox(square, refFrame, wideCanvas)!;
		// Wider canvas should produce a bigger lon span (extra side padding) but
		// not a bigger lat span — letterbox grows the horizontal axis only.
		expect(wide.maxLon - wide.minLon).toBeGreaterThan(tight.maxLon - tight.minLon);
		expect(wide.maxLat - wide.minLat).toBeCloseTo(tight.maxLat - tight.minLat, 6);
	});
});

describe('tileFadeOpacity', () => {
	it('returns 1 below TILE_FADE_START and 0 above TILE_FADE_END', () => {
		expect(tileFadeOpacity(0)).toBe(1);
		expect(tileFadeOpacity(TILE_FADE_START)).toBe(1);
		expect(tileFadeOpacity(TILE_FADE_END)).toBe(0);
		expect(tileFadeOpacity(Math.PI)).toBe(0);
	});

	it('interpolates linearly across the fade window', () => {
		const mid = (TILE_FADE_START + TILE_FADE_END) / 2;
		expect(tileFadeOpacity(mid)).toBeCloseTo(0.5, 6);
	});

	it('is monotonically non-increasing across the full pitch range', () => {
		let prev = tileFadeOpacity(0);
		for (let p = 0; p <= Math.PI / 2; p += Math.PI / 64) {
			const cur = tileFadeOpacity(p);
			expect(cur).toBeLessThanOrEqual(prev + 1e-12);
			prev = cur;
		}
	});
});
