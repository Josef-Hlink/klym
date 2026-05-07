import { describe, it, expect } from 'vitest';
import type { GradeBin } from '../elevation.js';
import type { RoutePoint } from '../types.js';
import {
	ANCHOR_STEP_M,
	buildAllDrapes,
	buildAnchorLines,
	buildBlockFaces,
	buildBoundaryAnchors,
	buildDrape,
	buildHoverHighlight,
	buildPolylineRuns,
	buildShadowPoints,
	buildTileTransform
} from './geometry.js';
import type { Projected, Projector, RefFrame } from './projection.js';
import type { TileImage } from './tiles.js';

// Identity-style projector: lon → x, -lat → y, ele → depth. Easy to read,
// preserves enough structure to verify ordering and shape without hauling in
// the real orthographic math.
const project: Projector = (lat, lon, ele) => [lon, -lat, ele] as Projected;

const refFrame: RefFrame = {
	centerLat: 45,
	centerLon: 5,
	centerEle: 50,
	cosLat: Math.cos((45 * Math.PI) / 180),
	xSpanM: 1000,
	ySpanM: 1000,
	minEle: 0,
	maxEle: 100
};

const tileImage: TileImage = {
	url: 'data:,',
	minLat: 44.99,
	maxLat: 45.01,
	minLon: 4.99,
	maxLon: 5.01
};

// Linear route, 0..1000m, ele 0..100m, point every 50m (21 points).
const route: RoutePoint[] = Array.from({ length: 21 }, (_, i) => ({
	lat: 45 + i * 0.0001,
	lon: 5 + i * 0.0001,
	ele: i * 5,
	cumDistM: i * 50
}));

describe('buildTileTransform', () => {
	it('returns null when tileImage or refFrame is missing', () => {
		expect(buildTileTransform(null, refFrame, project)).toBeNull();
		expect(buildTileTransform(tileImage, null, project)).toBeNull();
	});

	it('produces an axis-aligned matrix under the identity projector', () => {
		// At pitch=0/yaw=0 with our identity projector (no scaling),
		// b = c = 0 (the parallelogram is rectangular). e/f are the NW corner.
		const m = buildTileTransform(tileImage, refFrame, project)!;
		expect(m).not.toBeNull();
		expect(m.b).toBeCloseTo(0, 10);
		expect(m.c).toBeCloseTo(0, 10);
		expect(m.a).toBeCloseTo(tileImage.maxLon - tileImage.minLon, 10);
		expect(m.d).toBeCloseTo(-(tileImage.minLat - tileImage.maxLat), 10);
		expect(m.e).toBeCloseTo(tileImage.minLon, 10);
		expect(m.f).toBeCloseTo(-tileImage.maxLat, 10);
	});
});

describe('buildBlockFaces', () => {
	it('returns four faces sorted back-to-front', () => {
		const faces = buildBlockFaces(tileImage, refFrame, project, 100);
		expect(faces).toHaveLength(4);
		for (let i = 1; i < faces.length; i++) {
			expect(faces[i].depth).toBeGreaterThanOrEqual(faces[i - 1].depth);
		}
	});

	it('returns an empty array when tileImage or refFrame is missing', () => {
		expect(buildBlockFaces(null, refFrame, project, 100)).toEqual([]);
		expect(buildBlockFaces(tileImage, null, project, 100)).toEqual([]);
	});
});

describe('buildShadowPoints', () => {
	it('returns one point per slicedPoint, all at refFrame.minEle', () => {
		const out = buildShadowPoints(route, refFrame, project);
		const tokens = out.split(' ');
		expect(tokens).toHaveLength(route.length);
		// Identity projector puts ele in slot 2, but shadow only uses x/y;
		// confirm parsing yields finite numbers and the count matches.
		for (const t of tokens) {
			const [x, y] = t.split(',').map(Number);
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(y)).toBe(true);
		}
	});

	it('returns an empty string when refFrame is missing or there is < 2 points', () => {
		expect(buildShadowPoints(route, null, project)).toBe('');
		expect(buildShadowPoints(route.slice(0, 1), refFrame, project)).toBe('');
	});
});

describe('buildAnchorLines', () => {
	it('samples at the requested step and includes both endpoints', () => {
		const lines = buildAnchorLines(route, 0, 1000, refFrame, project, 250);
		// Step 250 across [0, 1000]: distances 0, 250, 500, 750, 1000 = 5 lines.
		expect(lines).toHaveLength(5);
	});

	it('iterates by step from startDistM and stops once d exceeds endDistM', () => {
		// Step 300 over [0, 1000]: d = 0, 300, 600, 900, then 1200 > 1000.001
		// exits the loop. Final anchor sits at 900, not 1000 — that gap is why
		// the boundary-anchor pass exists separately to pin the segment end.
		const lines = buildAnchorLines(route, 0, 1000, refFrame, project, 300);
		expect(lines).toHaveLength(4);
	});

	it('returns no lines when the range is degenerate or refFrame missing', () => {
		expect(buildAnchorLines(route, 500, 500, refFrame, project)).toEqual([]);
		expect(buildAnchorLines(route, 0, 1000, null, project)).toEqual([]);
	});

	it('defaults the sample step to ANCHOR_STEP_M (250m)', () => {
		const a = buildAnchorLines(route, 0, 1000, refFrame, project);
		const b = buildAnchorLines(route, 0, 1000, refFrame, project, ANCHOR_STEP_M);
		expect(a.length).toBe(b.length);
	});
});

describe('buildBoundaryAnchors', () => {
	const bins: GradeBin[] = [
		{ startM: 0, endM: 500, startEle: 0, endEle: 50, grade: 10 },
		{ startM: 500, endM: 1000, startEle: 50, endEle: 100, grade: 10 }
	];

	it('emits one anchor per bin, each tagged with the bin colour', () => {
		const anchors = buildBoundaryAnchors(route, bins, refFrame, project);
		expect(anchors).toHaveLength(2);
		expect(anchors[0].color).toMatch(/^#/);
	});

	it('returns an empty array when bins is empty or refFrame missing', () => {
		expect(buildBoundaryAnchors(route, [], refFrame, project)).toEqual([]);
		expect(buildBoundaryAnchors(route, bins, null, project)).toEqual([]);
	});
});

describe('buildPolylineRuns', () => {
	const projectedPoints: Projected[] = route.map((p) => [p.lon, -p.lat, p.ele]);

	it('collapses a single-bin route into one run', () => {
		const bins: GradeBin[] = [
			{ startM: 0, endM: 1000, startEle: 0, endEle: 100, grade: 10 }
		];
		const runs = buildPolylineRuns(route, projectedPoints, bins, refFrame);
		expect(runs).toHaveLength(1);
		expect(runs[0].points.split(' ')).toHaveLength(route.length);
	});

	it('breaks a route into multiple runs when bins have different colours', () => {
		// Two bins with grades that map to different gradeColor buckets
		// (1% → amber, 10% → deep red).
		const bins: GradeBin[] = [
			{ startM: 0, endM: 500, startEle: 0, endEle: 5, grade: 1 },
			{ startM: 500, endM: 1000, startEle: 5, endEle: 105, grade: 10 }
		];
		const runs = buildPolylineRuns(route, projectedPoints, bins, refFrame);
		expect(runs.length).toBeGreaterThan(1);
	});

	it('sorts runs back-to-front by depth', () => {
		const bins: GradeBin[] = [
			{ startM: 0, endM: 500, startEle: 0, endEle: 5, grade: 1 },
			{ startM: 500, endM: 1000, startEle: 5, endEle: 105, grade: 10 }
		];
		const runs = buildPolylineRuns(route, projectedPoints, bins, refFrame);
		for (let i = 1; i < runs.length; i++) {
			expect(runs[i].depth).toBeGreaterThanOrEqual(runs[i - 1].depth);
		}
	});

	it('returns no runs when the route has < 2 points or refFrame missing', () => {
		expect(buildPolylineRuns([route[0]], [projectedPoints[0]], [], refFrame)).toEqual([]);
		expect(buildPolylineRuns(route, projectedPoints, [], null)).toEqual([]);
	});
});

describe('buildDrape', () => {
	const bin: GradeBin = { startM: 200, endM: 600, startEle: 20, endEle: 60, grade: 10 };

	it('returns one M..L..L..L..Z quad per route segment within the bin', () => {
		const { polyline, drape } = buildDrape(bin, route, route, refFrame, project);
		const quads = (drape.match(/M[^M]+/g) ?? []).length;
		// Bin spans [200, 600] over a 50m-spaced route. Inclusive-exclusive
		// scan picks up vertices 250, 300, 350, 400, 450, 500, 550 — plus the
		// interpolated start (200) and end (600) → 9 tops, 8 quads.
		expect(quads).toBe(8);
		expect(polyline.split(' ')).toHaveLength(9);
	});

	it('returns empty paths when refFrame is missing', () => {
		const out = buildDrape(bin, route, route, null, project);
		expect(out).toEqual({ polyline: '', drape: '' });
	});
});

describe('buildHoverHighlight', () => {
	const bins: GradeBin[] = [
		{ startM: 0, endM: 500, startEle: 0, endEle: 50, grade: 10 },
		{ startM: 500, endM: 1000, startEle: 50, endEle: 100, grade: 10 }
	];

	it('returns the bin under the hovered distance', () => {
		const out = buildHoverHighlight(250, bins, route, route, refFrame, project);
		expect(out.color).toMatch(/^#/);
		expect(out.polyline.length).toBeGreaterThan(0);
		expect(out.drape.length).toBeGreaterThan(0);
	});

	it('returns the empty highlight when distM is null or no bin matches', () => {
		const empty = { polyline: '', drape: '', color: '' };
		expect(buildHoverHighlight(null, bins, route, route, refFrame, project)).toEqual(empty);
		expect(buildHoverHighlight(250, [], route, route, refFrame, project)).toEqual(empty);
		expect(buildHoverHighlight(250, bins, route, route, null, project)).toEqual(empty);
	});
});

describe('buildAllDrapes', () => {
	const bins: GradeBin[] = [
		{ startM: 0, endM: 500, startEle: 0, endEle: 50, grade: 10 },
		{ startM: 500, endM: 1000, startEle: 50, endEle: 100, grade: 10 }
	];

	it('emits one drape entry per bin', () => {
		const out = buildAllDrapes(bins, route, route, refFrame, project);
		expect(out).toHaveLength(bins.length);
		for (const d of out) {
			expect(d.color).toMatch(/^#/);
			expect(d.drape.length).toBeGreaterThan(0);
		}
	});

	it('returns an empty array when bins is empty or refFrame missing', () => {
		expect(buildAllDrapes([], route, route, refFrame, project)).toEqual([]);
		expect(buildAllDrapes(bins, route, route, null, project)).toEqual([]);
	});
});
