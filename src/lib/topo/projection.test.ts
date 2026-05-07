import { describe, it, expect } from 'vitest';
import {
	clampDataAspect,
	computeDimensions,
	computeRefFrame,
	makeProjector,
	MAX_CANVAS_ASPECT,
	MIN_CANVAS_ASPECT,
	M_PER_DEG,
	projectLLE,
	rotate3d,
	VB_W,
	type ProjectCtx,
	type RefFrame
} from './projection.js';

const TAU = Math.PI * 2;

describe('rotate3d', () => {
	it('is the identity at yaw=0, pitch=0', () => {
		const [x, y, z] = rotate3d(3, 5, 7, 0, 0);
		expect(x).toBeCloseTo(3, 10);
		expect(y).toBeCloseTo(5, 10);
		expect(z).toBeCloseTo(7, 10);
	});

	it('preserves vector length under any (yaw, pitch)', () => {
		const cases: [number, number, number, number, number][] = [
			[1, 0, 0, Math.PI / 3, Math.PI / 6],
			[0, 1, 0, Math.PI / 4, -Math.PI / 4],
			[2, -3, 5, 1.234, -0.567]
		];
		for (const [x, y, z, yaw, pitch] of cases) {
			const before = Math.hypot(x, y, z);
			const [a, b, c] = rotate3d(x, y, z, yaw, pitch);
			expect(Math.hypot(a, b, c)).toBeCloseTo(before, 9);
		}
	});

	it('yaw=π rotates (1, 0, 0) to (-1, 0, 0)', () => {
		const [x, y, z] = rotate3d(1, 0, 0, Math.PI, 0);
		expect(x).toBeCloseTo(-1, 10);
		expect(y).toBeCloseTo(0, 10);
		expect(z).toBeCloseTo(0, 10);
	});

	it('pitch>0 raises a high-z point on screen (smaller SVG y means larger rotated y)', () => {
		// projectLLE flips rotated y to SVG y via `cy - vy*scale`, so a larger
		// rotated y == a smaller SVG y. For an above-centre point (z>0), pitch>0
		// should produce a positive rotated y component.
		const [, y] = rotate3d(0, 0, 10, 0, Math.PI / 4);
		expect(y).toBeGreaterThan(0);
	});

	it('a full revolution returns to the original vector', () => {
		const [x, y, z] = rotate3d(2, 3, 4, TAU, TAU);
		expect(x).toBeCloseTo(2, 9);
		expect(y).toBeCloseTo(3, 9);
		expect(z).toBeCloseTo(4, 9);
	});
});

describe('computeRefFrame', () => {
	it('returns null with fewer than two points', () => {
		expect(computeRefFrame([])).toBeNull();
		expect(computeRefFrame([{ lat: 45, lon: 5, ele: 100 }])).toBeNull();
	});

	it('centres on the bbox midpoint', () => {
		const f = computeRefFrame([
			{ lat: 45, lon: 5, ele: 100 },
			{ lat: 46, lon: 6, ele: 200 }
		]);
		expect(f).not.toBeNull();
		expect(f!.centerLat).toBeCloseTo(45.5, 10);
		expect(f!.centerLon).toBeCloseTo(5.5, 10);
		expect(f!.centerEle).toBeCloseTo(150, 10);
		expect(f!.minEle).toBe(100);
		expect(f!.maxEle).toBe(200);
	});

	it('cosLat shrinks the lon span as you move toward the poles', () => {
		const equator = computeRefFrame([
			{ lat: 0, lon: 0, ele: 0 },
			{ lat: 0.001, lon: 1, ele: 0 }
		]);
		const high = computeRefFrame([
			{ lat: 60, lon: 0, ele: 0 },
			{ lat: 60.001, lon: 1, ele: 0 }
		]);
		expect(equator!.xSpanM).toBeGreaterThan(high!.xSpanM);
		// cos(60°) = 0.5, so the high-lat lon span should be ~half the equator one.
		expect(high!.xSpanM / equator!.xSpanM).toBeCloseTo(0.5, 2);
	});

	it('floors xSpanM and ySpanM at 1 to avoid divide-by-zero on degenerate input', () => {
		const f = computeRefFrame([
			{ lat: 45, lon: 5, ele: 100 },
			{ lat: 45, lon: 5, ele: 200 }
		]);
		expect(f!.xSpanM).toBe(1);
		expect(f!.ySpanM).toBe(1);
	});
});

describe('computeDimensions', () => {
	it('returns the safe default when refFrame is null', () => {
		const d = computeDimensions(null, 2);
		expect(d.W).toBe(VB_W);
		expect(d.H).toBe(600);
		expect(d.scale).toBe(1);
	});

	it('inner height is innerW / canvasAspect', () => {
		const f: RefFrame = {
			centerLat: 45,
			centerLon: 5,
			centerEle: 100,
			cosLat: Math.cos((45 * Math.PI) / 180),
			xSpanM: 5000,
			ySpanM: 2000,
			minEle: 50,
			maxEle: 150
		};
		const d = computeDimensions(f, 2);
		expect(d.innerH).toBeCloseTo(d.innerW / 2, 6);
	});

	it('picks the smaller of the two axis scales so the route fits in both axes', () => {
		// Tall route: ySpanM dominates, scale should be limited by innerH/ySpanM.
		const tall: RefFrame = {
			centerLat: 45, centerLon: 5, centerEle: 100,
			cosLat: 1, xSpanM: 100, ySpanM: 100000,
			minEle: 0, maxEle: 200
		};
		const d = computeDimensions(tall, 2);
		expect(d.scale).toBeCloseTo(d.innerH / tall.ySpanM, 6);
	});
});

describe('clampDataAspect', () => {
	it('falls back to MIN when refFrame is null', () => {
		expect(clampDataAspect(null)).toBe(MIN_CANVAS_ASPECT);
	});

	it('clamps a very-portrait route up to MIN', () => {
		const f: RefFrame = {
			centerLat: 0, centerLon: 0, centerEle: 0,
			cosLat: 1, xSpanM: 100, ySpanM: 10000,
			minEle: 0, maxEle: 100
		};
		expect(clampDataAspect(f)).toBe(MIN_CANVAS_ASPECT);
	});

	it('clamps a very-wide route down to MAX', () => {
		const f: RefFrame = {
			centerLat: 0, centerLon: 0, centerEle: 0,
			cosLat: 1, xSpanM: 100000, ySpanM: 100,
			minEle: 0, maxEle: 100
		};
		expect(clampDataAspect(f)).toBe(MAX_CANVAS_ASPECT);
	});

	it('passes a moderate aspect through untouched', () => {
		const f: RefFrame = {
			centerLat: 0, centerLon: 0, centerEle: 0,
			cosLat: 1, xSpanM: 4000, ySpanM: 2000,
			minEle: 0, maxEle: 100
		};
		expect(clampDataAspect(f)).toBeCloseTo(2, 10);
	});
});

describe('projectLLE / makeProjector', () => {
	const pts = [
		{ lat: 45, lon: 5, ele: 100 },
		{ lat: 46, lon: 6, ele: 200 }
	];
	const refFrame = computeRefFrame(pts)!;
	const dimensions = computeDimensions(refFrame, 2);
	const ctxFlat: ProjectCtx = {
		refFrame,
		dimensions,
		yaw: 0,
		pitch: 0,
		zExaggeration: 1
	};

	it('the centre of the refFrame projects to the canvas centre at pitch=0, yaw=0', () => {
		const [sx, sy] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle, ctxFlat);
		expect(sx).toBeCloseTo(VB_W / 2, 6);
		expect(sy).toBeCloseTo(dimensions.H / 2, 6);
	});

	it('east of centre lands right of centre at top-down', () => {
		const [sx] = projectLLE(refFrame.centerLat, refFrame.centerLon + 0.01, refFrame.centerEle, ctxFlat);
		expect(sx).toBeGreaterThan(VB_W / 2);
	});

	it('north of centre lands above centre (smaller SVG y) at top-down', () => {
		const [, sy] = projectLLE(refFrame.centerLat + 0.01, refFrame.centerLon, refFrame.centerEle, ctxFlat);
		expect(sy).toBeLessThan(dimensions.H / 2);
	});

	it('depth is 0 at refFrame centre elevation when pitch=0, then positive above the centre', () => {
		const [, , d0] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle, ctxFlat);
		const [, , dHigh] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle + 50, ctxFlat);
		expect(d0).toBeCloseTo(0, 6);
		expect(dHigh).toBeGreaterThan(0);
	});

	it('zExaggeration scales the depth at pitch=0', () => {
		const ctx2x: ProjectCtx = { ...ctxFlat, zExaggeration: 2 };
		const [, , d1] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle + 50, ctxFlat);
		const [, , d2] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle + 50, ctx2x);
		expect(d2).toBeCloseTo(d1 * 2, 6);
	});

	it('pitch>0 lifts a high-elevation point on screen (smaller SVG y)', () => {
		const ctxTilted: ProjectCtx = { ...ctxFlat, pitch: Math.PI / 4 };
		const [, syFlat] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle + 100, ctxFlat);
		const [, syTilt] = projectLLE(refFrame.centerLat, refFrame.centerLon, refFrame.centerEle + 100, ctxTilted);
		expect(syTilt).toBeLessThan(syFlat);
	});

	it('makeProjector returns the same value as projectLLE for the same ctx', () => {
		const proj = makeProjector(ctxFlat);
		const a = proj(refFrame.centerLat + 0.005, refFrame.centerLon + 0.005, refFrame.centerEle + 25);
		const b = projectLLE(refFrame.centerLat + 0.005, refFrame.centerLon + 0.005, refFrame.centerEle + 25, ctxFlat);
		expect(a).toEqual(b);
	});
});

describe('M_PER_DEG sanity', () => {
	it('one degree of latitude is about 111km', () => {
		// Loose check that the shorthand matches reality at the equator
		// (111111m ≈ true ~110574m at equator, ~111693m at poles).
		expect(M_PER_DEG).toBeGreaterThan(110_000);
		expect(M_PER_DEG).toBeLessThan(112_000);
	});
});
