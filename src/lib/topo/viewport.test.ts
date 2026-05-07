import { describe, it, expect } from 'vitest';
import type { Dimensions } from './projection.js';
import {
	applyZoomAtCursor,
	clampViewport,
	defaultViewport,
	formatViewBox,
	isZoomedOrPanned,
	MAX_VIEW_FRAC,
	MIN_VIEW_FRAC,
	PAN_MARGIN_FRAC,
	ZOOM_FACTOR
} from './viewport.js';

const dim: Dimensions = { W: 1600, H: 800, innerW: 1536, innerH: 736, scale: 1 };

describe('defaultViewport', () => {
	it('covers the full natural canvas', () => {
		const v = defaultViewport(dim);
		expect(v).toEqual({ x: 0, y: 0, w: dim.W, h: dim.H });
	});
});

describe('clampViewport', () => {
	it('leaves an in-range viewport untouched', () => {
		const v = { x: 100, y: 50, w: 800, h: 400 };
		expect(clampViewport(v, dim)).toEqual(v);
	});

	it('clamps left/top past the negative pan-margin', () => {
		const v = { x: -10000, y: -10000, w: 800, h: 400 };
		const out = clampViewport(v, dim);
		expect(out.x).toBe(-dim.W * PAN_MARGIN_FRAC);
		expect(out.y).toBe(-dim.H * PAN_MARGIN_FRAC);
	});

	it('clamps right/bottom past the positive pan-margin', () => {
		const v = { x: 10000, y: 10000, w: 800, h: 400 };
		const out = clampViewport(v, dim);
		expect(out.x).toBe(dim.W + dim.W * PAN_MARGIN_FRAC - v.w);
		expect(out.y).toBe(dim.H + dim.H * PAN_MARGIN_FRAC - v.h);
	});

	it('centres a viewport that is wider than natural+margin', () => {
		// w larger than W + 2*marginX means there's no valid pan position;
		// fall back to centring on the canvas.
		const w = dim.W * (1 + 2 * PAN_MARGIN_FRAC) + 100;
		const v = { x: -9999, y: 0, w, h: dim.H };
		const out = clampViewport(v, dim);
		expect(out.x).toBeCloseTo((dim.W - w) / 2, 6);
	});
});

describe('applyZoomAtCursor', () => {
	const start = defaultViewport(dim);

	it('zooms in (negative wheel delta) shrinks the viewport by ZOOM_FACTOR', () => {
		const out = applyZoomAtCursor(start, dim, 0.5, 0.5, -1);
		expect(out.w).toBeCloseTo(start.w * ZOOM_FACTOR, 6);
		expect(out.h).toBeCloseTo(start.h * ZOOM_FACTOR, 6);
	});

	it('zooms out (positive wheel delta) enlarges the viewport by 1/ZOOM_FACTOR', () => {
		// Start half-zoomed-in so we have room to enlarge before hitting MAX.
		const half = { x: 400, y: 200, w: dim.W / 2, h: dim.H / 2 };
		const out = applyZoomAtCursor(half, dim, 0.5, 0.5, +1);
		expect(out.w).toBeCloseTo(half.w / ZOOM_FACTOR, 6);
	});

	it('keeps the world point under the cursor pinned through the zoom', () => {
		// At cursor (relX=0.25, relY=0.75), world point is viewport.x + 0.25*w etc.
		// After the zoom, the same relative cursor should still map to the same
		// world point — that's the whole "zoom into where I'm pointing" feel.
		const v = { x: 100, y: 50, w: 800, h: 400 };
		const relX = 0.25;
		const relY = 0.75;
		const cursorBefore = { x: v.x + relX * v.w, y: v.y + relY * v.h };
		const after = applyZoomAtCursor(v, dim, relX, relY, -1);
		const cursorAfter = { x: after.x + relX * after.w, y: after.y + relY * after.h };
		expect(cursorAfter.x).toBeCloseTo(cursorBefore.x, 6);
		expect(cursorAfter.y).toBeCloseTo(cursorBefore.y, 6);
	});

	it('floors the viewport width at MIN_VIEW_FRAC * dimensions.W', () => {
		// Repeated zoom-ins should never go below the floor.
		let v = defaultViewport(dim);
		for (let i = 0; i < 200; i++) v = applyZoomAtCursor(v, dim, 0.5, 0.5, -1);
		expect(v.w).toBeCloseTo(dim.W * MIN_VIEW_FRAC, 6);
	});

	it('caps the viewport width at MAX_VIEW_FRAC * dimensions.W', () => {
		let v = defaultViewport(dim);
		for (let i = 0; i < 200; i++) v = applyZoomAtCursor(v, dim, 0.5, 0.5, +1);
		expect(v.w).toBeCloseTo(dim.W * MAX_VIEW_FRAC, 6);
	});

	it('preserves aspect ratio (h scales with w by the same factor)', () => {
		const v = { x: 0, y: 0, w: dim.W, h: dim.H };
		const out = applyZoomAtCursor(v, dim, 0.3, 0.7, -1);
		expect(out.h / out.w).toBeCloseTo(v.h / v.w, 6);
	});
});

describe('isZoomedOrPanned', () => {
	it('false for a null viewport (initial state before refFrame settles)', () => {
		expect(isZoomedOrPanned(null, dim)).toBe(false);
	});

	it('false for the natural viewport (no pan, no zoom)', () => {
		expect(isZoomedOrPanned(defaultViewport(dim), dim)).toBe(false);
	});

	it('tolerates sub-half-pixel float drift', () => {
		const drifted = { x: 0.4, y: -0.4, w: dim.W + 0.4, h: dim.H - 0.4 };
		expect(isZoomedOrPanned(drifted, dim)).toBe(false);
	});

	it('true when panned beyond the tolerance', () => {
		expect(isZoomedOrPanned({ x: 5, y: 0, w: dim.W, h: dim.H }, dim)).toBe(true);
	});

	it('true when zoomed beyond the tolerance', () => {
		expect(isZoomedOrPanned({ x: 0, y: 0, w: dim.W * 0.8, h: dim.H * 0.8 }, dim)).toBe(true);
	});
});

describe('formatViewBox', () => {
	it('uses the natural canvas when viewport is null', () => {
		expect(formatViewBox(null, dim)).toBe(`0 0 ${dim.W} ${dim.H}`);
	});

	it('serialises a viewport as "x y w h"', () => {
		expect(formatViewBox({ x: 10, y: 20, w: 800, h: 400 }, dim)).toBe('10 20 800 400');
	});
});
