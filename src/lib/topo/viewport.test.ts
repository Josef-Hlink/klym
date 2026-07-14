import { describe, it, expect } from 'vitest';
import type { Dimensions } from './projection.js';
import {
	applyZoomAtCursor,
	clampViewport,
	computeViewTransform,
	defaultViewport,
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

describe('computeViewTransform', () => {
	// dim is 1600×800 (aspect 2), so a 800×400 CSS canvas at dpr 1 is an
	// exact fit for the natural viewport.
	it('exact fit: k = cssW/w, no letterbox offset, no pan offset', () => {
		const t = computeViewTransform(defaultViewport(dim), dim, 800, 400, 1)!;
		expect(t.k).toBeCloseTo(0.5, 10);
		expect(t.tx).toBeCloseTo(0, 10);
		expect(t.ty).toBeCloseTo(0, 10);
	});

	it('letterboxes vertically when the canvas is taller than the viewport aspect', () => {
		// 800×800 canvas, 1600×800 viewport → k limited by width (0.5),
		// content is 400 device px tall → 200px top offset (xMidYMid meet).
		const t = computeViewTransform(defaultViewport(dim), dim, 800, 800, 1)!;
		expect(t.k).toBeCloseTo(0.5, 10);
		expect(t.tx).toBeCloseTo(0, 10);
		expect(t.ty).toBeCloseTo(200, 10);
	});

	it('letterboxes horizontally when the canvas is wider than the viewport aspect', () => {
		// 1600×400 canvas → k limited by height (0.5), content 800 device px
		// wide → 400px left offset.
		const t = computeViewTransform(defaultViewport(dim), dim, 1600, 400, 1)!;
		expect(t.k).toBeCloseTo(0.5, 10);
		expect(t.tx).toBeCloseTo(400, 10);
		expect(t.ty).toBeCloseTo(0, 10);
	});

	it('pan shifts the translation by -x·k / -y·k', () => {
		const base = computeViewTransform(defaultViewport(dim), dim, 800, 400, 1)!;
		const panned = computeViewTransform(
			{ x: 100, y: -40, w: dim.W, h: dim.H },
			dim,
			800,
			400,
			1
		)!;
		expect(panned.k).toBeCloseTo(base.k, 10);
		expect(panned.tx).toBeCloseTo(base.tx - 100 * base.k, 10);
		expect(panned.ty).toBeCloseTo(base.ty + 40 * base.k, 10);
	});

	it('dpr scales k (and offsets) proportionally', () => {
		const t1 = computeViewTransform(defaultViewport(dim), dim, 800, 800, 1)!;
		const t2 = computeViewTransform(defaultViewport(dim), dim, 800, 800, 2)!;
		expect(t2.k).toBeCloseTo(t1.k * 2, 10);
		expect(t2.tx).toBeCloseTo(t1.tx * 2, 10);
		expect(t2.ty).toBeCloseTo(t1.ty * 2, 10);
	});

	it('a zoomed-in viewport maps its window to the full canvas', () => {
		// Viewport = right half of the canvas: a world point at the viewport
		// origin lands at device (0, 0); the viewport centre lands mid-canvas.
		const v = { x: 800, y: 400, w: 800, h: 400 };
		const t = computeViewTransform(v, dim, 800, 400, 1)!;
		expect(v.x * t.k + t.tx).toBeCloseTo(0, 10);
		expect(v.y * t.k + t.ty).toBeCloseTo(0, 10);
		expect((v.x + v.w / 2) * t.k + t.tx).toBeCloseTo(400, 10);
	});

	it('null viewport falls back to the natural canvas', () => {
		expect(computeViewTransform(null, dim, 800, 400, 1)).toEqual(
			computeViewTransform(defaultViewport(dim), dim, 800, 400, 1)
		);
	});

	it('returns null for degenerate sizes', () => {
		expect(computeViewTransform(defaultViewport(dim), dim, 0, 400, 1)).toBeNull();
		expect(computeViewTransform(defaultViewport(dim), dim, 800, 0, 1)).toBeNull();
		expect(computeViewTransform({ x: 0, y: 0, w: 0, h: 400 }, dim, 800, 400, 1)).toBeNull();
		expect(computeViewTransform(defaultViewport(dim), dim, 800, 400, 0)).toBeNull();
	});
});
