// Per-frame geometry builders for the segment topo view. Each function
// projects route data through a `Projector` (closure-bound to the current
// camera) and returns SVG-ready primitives — point strings, line segment
// records, path data — for the component template to draw.
//
// All functions are pure given a Projector. The component owns the
// reactive Projector and re-runs these helpers whenever camera state
// changes; nothing in here touches reactive state directly.

import { findPointAtDistance, gradeColor, type ColorTheme, type GradeBin } from '../elevation.js';
import type { RoutePoint } from '../types.js';
import type { Projected, Projector, RefFrame } from './projection.js';
import type { TileImage } from './tiles.js';

// Sample spacing for the thin background anchor lines so density stays
// stable regardless of GPX point density.
export const ANCHOR_STEP_M = 250;

// Ground elevation lookup. Builders that drop geometry to "the ground"
// (shadow, anchors, drapes) take an optional sampler; the default is the
// flat plane at refFrame.minEle, which the terrain mode replaces with a
// DEM lookup so bottoms land on the terrain surface.
export type GroundEleAt = (lat: number, lon: number) => number;

const flatGround = (refFrame: RefFrame): GroundEleAt => {
	const minEle = refFrame.minEle;
	return () => minEle;
};

// Affine matrix that maps the unit square to the rotated ground
// parallelogram. Orthographic projection preserves parallelism, so a planar
// rectangle (the OSM tile snapshot at minEle) stays a parallelogram under
// any rotation — an affine matrix is sufficient.
export type TileTransform = {
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
};

export function buildTileTransform(
	tileImage: TileImage | null,
	refFrame: RefFrame | null,
	project: Projector
): TileTransform | null {
	if (!tileImage || !refFrame) return null;
	const ground = refFrame.minEle;
	const tl = project(tileImage.maxLat, tileImage.minLon, ground); // north-west
	const tr = project(tileImage.maxLat, tileImage.maxLon, ground); // north-east
	const bl = project(tileImage.minLat, tileImage.minLon, ground); // south-west
	return {
		a: tr[0] - tl[0],
		b: tr[1] - tl[1],
		c: bl[0] - tl[0],
		d: bl[1] - tl[1],
		e: tl[0],
		f: tl[1]
	};
}

// Side faces of the "earth block" the OSM ground sits on. Each face is a
// parallelogram (top edge at minEle, bottom edge at minEle - blockDepthM).
// Sorted back-to-front so painter's algorithm hides the rear faces.
export type BlockFace = { points: string; depth: number };

export function buildBlockFaces(
	tileImage: TileImage | null,
	refFrame: RefFrame | null,
	project: Projector,
	blockDepthM: number
): BlockFace[] {
	if (!tileImage || !refFrame) return [];
	const top = refFrame.minEle;
	const bot = refFrame.minEle - blockDepthM;
	const nwT = project(tileImage.maxLat, tileImage.minLon, top);
	const neT = project(tileImage.maxLat, tileImage.maxLon, top);
	const seT = project(tileImage.minLat, tileImage.maxLon, top);
	const swT = project(tileImage.minLat, tileImage.minLon, top);
	const nwB = project(tileImage.maxLat, tileImage.minLon, bot);
	const neB = project(tileImage.maxLat, tileImage.maxLon, bot);
	const seB = project(tileImage.minLat, tileImage.maxLon, bot);
	const swB = project(tileImage.minLat, tileImage.minLon, bot);

	const faces: { corners: Projected[] }[] = [
		{ corners: [nwT, neT, neB, nwB] }, // N
		{ corners: [neT, seT, seB, neB] }, // E
		{ corners: [seT, swT, swB, seB] }, // S
		{ corners: [swT, nwT, nwB, swB] } // W
	];

	const out: BlockFace[] = faces.map((f) => ({
		points: f.corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' '),
		depth: (f.corners[0][2] + f.corners[1][2] + f.corners[2][2] + f.corners[3][2]) / 4
	}));
	out.sort((a, b) => a.depth - b.depth);
	return out;
}

// Flat ground-projected shadow of the route — every point dropped to the
// segment's minimum elevation. At pitch=0 it overlaps the real route
// exactly; as you tilt, the shadow separates and anchors the route.
export function buildShadowPoints(
	slicedPoints: readonly RoutePoint[],
	refFrame: RefFrame | null,
	project: Projector,
	groundEleAt?: GroundEleAt
): string {
	if (!refFrame || slicedPoints.length < 2) return '';
	const groundAt = groundEleAt ?? flatGround(refFrame);
	const parts: string[] = [];
	for (const p of slicedPoints) {
		const [x, y] = project(p.lat, p.lon, groundAt(p.lat, p.lon));
		parts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
	}
	return parts.join(' ');
}

export type AnchorLine = { x1: number; y1: number; x2: number; y2: number };

// Subtle vertical anchor lines from the route surface down to the segment's
// lowest elevation. Sampled at fixed distance intervals so density stays
// independent of GPX point density.
export function buildAnchorLines(
	points: readonly RoutePoint[],
	startDistM: number,
	endDistM: number,
	refFrame: RefFrame | null,
	project: Projector,
	stepM: number = ANCHOR_STEP_M,
	groundEleAt?: GroundEleAt,
	visibleAt?: (distM: number) => boolean
): AnchorLine[] {
	const out: AnchorLine[] = [];
	if (!refFrame || endDistM <= startDistM) return out;
	const groundAt = groundEleAt ?? flatGround(refFrame);
	for (let d = startDistM; d <= endDistM + 1e-3; d += stepM) {
		const distM = Math.min(d, endDistM);
		if (visibleAt && !visibleAt(distM)) continue;
		const ip = findPointAtDistance(points as RoutePoint[], distM);
		const [tx, ty] = project(ip.lat, ip.lon, ip.ele);
		const [bx, by] = project(ip.lat, ip.lon, groundAt(ip.lat, ip.lon));
		out.push({ x1: tx, y1: ty, x2: bx, y2: by });
	}
	return out;
}

export type BoundaryAnchor = AnchorLine & { color: string };

// Heavier anchor lines at each segment-bin boundary, colored by the bin
// that ends at the boundary. Anchors the last point (start is anchored by
// the green start dot already).
export function buildBoundaryAnchors(
	points: readonly RoutePoint[],
	bins: readonly GradeBin[],
	refFrame: RefFrame | null,
	project: Projector,
	theme: ColorTheme = 'klym',
	groundEleAt?: GroundEleAt,
	visibleAt?: (distM: number) => boolean
): BoundaryAnchor[] {
	const out: BoundaryAnchor[] = [];
	if (!refFrame || bins.length === 0) return out;
	const groundAt = groundEleAt ?? flatGround(refFrame);
	for (const bin of bins) {
		if (visibleAt && !visibleAt(bin.endM)) continue;
		const ip = findPointAtDistance(points as RoutePoint[], bin.endM);
		const [tx, ty] = project(ip.lat, ip.lon, ip.ele);
		const [bx, by] = project(ip.lat, ip.lon, groundAt(ip.lat, ip.lon));
		out.push({ x1: tx, y1: ty, x2: bx, y2: by, color: gradeColor(bin.grade, theme) });
	}
	return out;
}

export type PolylineRun = { points: string; color: string; depth: number };

// Group the route into runs of consecutive same-color segments and tag
// each run with its average depth, so the template can draw back-to-front
// (painter's algorithm) without per-segment SVG elements.
//
// `visible` (optional, per POINT) is the terrain-occlusion mask from
// visibility.ts: a segment draws only when BOTH its endpoints are visible
// (conservative — the route tucks behind a ridge at the last visible
// point), and hidden segments simply break the runs. Omitted = all
// visible, byte-identical to the unmasked output.
export function buildPolylineRuns(
	slicedPoints: readonly RoutePoint[],
	projectedPoints: readonly Projected[],
	bins: readonly GradeBin[],
	refFrame: RefFrame | null,
	theme: ColorTheme = 'klym',
	visible?: readonly boolean[]
): PolylineRun[] {
	const out: PolylineRun[] = [];
	if (slicedPoints.length < 2 || !refFrame) return out;

	const segColors: string[] = new Array(slicedPoints.length - 1);
	let binIdx = 0;
	for (let i = 0; i < slicedPoints.length - 1; i++) {
		const midDist = (slicedPoints[i].cumDistM + slicedPoints[i + 1].cumDistM) / 2;
		while (binIdx < bins.length - 1 && bins[binIdx].endM < midDist) binIdx++;
		const grade = bins[binIdx]?.grade ?? 0;
		segColors[i] = gradeColor(grade, theme);
	}
	const segVisible = (i: number) => !visible || (visible[i] === true && visible[i + 1] === true);

	let runStart = 0;
	for (let i = 0; i < segColors.length; i++) {
		if (!segVisible(i)) {
			runStart = i + 1;
			continue;
		}
		const isLast = i === segColors.length - 1;
		const breakAfter = isLast || segColors[i + 1] !== segColors[i] || !segVisible(i + 1);
		if (breakAfter) {
			const pts: string[] = [];
			let depthSum = 0;
			let depthCount = 0;
			for (let j = runStart; j <= i + 1; j++) {
				const [x, y, d] = projectedPoints[j];
				pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
				depthSum += d;
				depthCount++;
			}
			out.push({
				points: pts.join(' '),
				color: segColors[i],
				depth: depthCount > 0 ? depthSum / depthCount : 0
			});
			runStart = i + 1;
		}
	}
	out.sort((a, b) => a.depth - b.depth);
	return out;
}

export type DrapePath = { polyline: string; drape: string };

// Build the "drape" geometry for a single bin: a path of per-segment quads
// from the route surface down to its shadow at refFrame.minEle, plus the
// top edge as a polyline (used for the hover halo).
export function buildDrape(
	bin: GradeBin,
	points: readonly RoutePoint[],
	slicedPoints: readonly RoutePoint[],
	refFrame: RefFrame | null,
	project: Projector,
	groundEleAt?: GroundEleAt
): DrapePath {
	if (!refFrame) return { polyline: '', drape: '' };
	const groundAt = groundEleAt ?? flatGround(refFrame);
	const tops: [number, number][] = [];
	const bots: [number, number][] = [];
	const addPoint = (lat: number, lon: number, ele: number) => {
		const t = project(lat, lon, ele);
		const b = project(lat, lon, groundAt(lat, lon));
		tops.push([t[0], t[1]]);
		bots.push([b[0], b[1]]);
	};

	const a = findPointAtDistance(points as RoutePoint[], bin.startM);
	addPoint(a.lat, a.lon, a.ele);
	for (const p of slicedPoints) {
		if (p.cumDistM <= bin.startM) continue;
		if (p.cumDistM >= bin.endM) break;
		addPoint(p.lat, p.lon, p.ele);
	}
	const z = findPointAtDistance(points as RoutePoint[], bin.endM);
	addPoint(z.lat, z.lon, z.ele);

	// Emit one quad per route segment with consistent clockwise winding so
	// the nonzero fill rule doesn't cancel overlap when the route revisits
	// an area (U-turns, switchbacks). One self-intersecting polygon would
	// cancel itself out where the top and bottom edges cross.
	const fmt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
	let drape = '';
	for (let i = 0; i < tops.length - 1; i++) {
		const A = tops[i];
		const B = tops[i + 1];
		const C = bots[i + 1];
		const D = bots[i];
		// Cross of (B-A) × (D-A); positive in y-down screen coords means CW.
		const cross = (B[0] - A[0]) * (D[1] - A[1]) - (B[1] - A[1]) * (D[0] - A[0]);
		const seq = cross >= 0 ? [A, B, C, D] : [A, D, C, B];
		drape += `M${fmt(seq[0])} L${fmt(seq[1])} L${fmt(seq[2])} L${fmt(seq[3])} Z `;
	}

	return { polyline: tops.map(fmt).join(' '), drape };
}

export type HoverHighlight = { polyline: string; drape: string; color: string };

// Reverse-highlight: when the chart reports a hovered distance, build the
// halo polyline + translucent drape for the bin under that distance.
export function buildHoverHighlight(
	externalHoverDistM: number | null,
	bins: readonly GradeBin[],
	points: readonly RoutePoint[],
	slicedPoints: readonly RoutePoint[],
	refFrame: RefFrame | null,
	project: Projector,
	theme: ColorTheme = 'klym',
	groundEleAt?: GroundEleAt
): HoverHighlight {
	const empty: HoverHighlight = { polyline: '', drape: '', color: '' };
	if (externalHoverDistM == null || !refFrame) return empty;
	let bin: GradeBin | null = null;
	for (const b of bins) {
		if (externalHoverDistM >= b.startM && externalHoverDistM <= b.endM) {
			bin = b;
			break;
		}
	}
	if (!bin) return empty;
	const { polyline, drape } = buildDrape(bin, points, slicedPoints, refFrame, project, groundEleAt);
	return { polyline, drape, color: gradeColor(bin.grade, theme) };
}

export type DrapeColored = { drape: string; color: string };

// Every bin gets a translucent fence down to the ground plane.
export function buildAllDrapes(
	bins: readonly GradeBin[],
	points: readonly RoutePoint[],
	slicedPoints: readonly RoutePoint[],
	refFrame: RefFrame | null,
	project: Projector,
	theme: ColorTheme = 'klym',
	groundEleAt?: GroundEleAt
): DrapeColored[] {
	if (!refFrame || bins.length === 0) return [];
	return bins.map((bin) => ({
		drape: buildDrape(bin, points, slicedPoints, refFrame, project, groundEleAt).drape,
		color: gradeColor(bin.grade, theme)
	}));
}
