// Paint-order reification for the segment topo view's canvas painter.
//
// `buildScene` turns the component's derived geometry (the outputs of the
// builders in geometry.ts / terrain.ts — it never calls a builder itself,
// so each derived keeps its own recompute cadence) into a flat, ordered
// list of draw ops. The op order IS the paint order, including the
// occlusion interleave the whole view depends on:
//
//   ground (back faces → mesh | flat faces → tile) → shadow → drapes →
//   anchors → SOLID route runs → hover halo → endpoint dots →
//   FRONT block faces (swallow route stretches behind walls) →
//   GHOST runs (above walls and mesh) → [hover marker, appended by the
//   component at paint time so pointermove doesn't rebuild the scene]
//
// 100% pure — images are referenced by string key ('ground'/'tile'), the
// executor (paint.ts) resolves them. Unit-tested in scene.test.ts; the
// occlusion interleave is locked in there.

import type {
	AnchorLine,
	BlockFace,
	BoundaryAnchor,
	DrapeColored,
	HoverHighlight,
	PolylineRun,
	TileTransform
} from './geometry.js';
import type { Projected } from './projection.js';
import type { ClipTriangle, TerrainFace, TriTransform } from './terrain.js';

type Pt = readonly [number, number];

export type ColoredLine = { x1: number; y1: number; x2: number; y2: number; color: string };

export type SceneOp =
	| {
			kind: 'polygon';
			pts: readonly Pt[];
			fill: string;
			stroke: string;
			strokeWidth: number;
			opacity: number;
	  }
	| {
			// The whole terrain mesh as ONE op: the executor draws it to an
			// offscreen layer and composites at `opacity` (group-opacity
			// semantics — per-triangle alpha would double-darken the dilated
			// seam overlaps into grid lines).
			kind: 'mesh';
			image: 'ground';
			triangles: readonly (TriTransform | null)[];
			clips: readonly ClipTriangle[];
			order: readonly number[];
			opacity: number;
	  }
	| { kind: 'image'; image: 'tile'; m: TileTransform; opacity: number }
	| {
			// One drape = one op = one fill: the quads are subpaths of a single
			// nonzero fill, so overlapping quads (switchbacks) don't accumulate
			// alpha.
			kind: 'quads';
			quads: readonly (readonly [Pt, Pt, Pt, Pt])[];
			color: string;
			opacity: number;
	  }
	| {
			kind: 'lines';
			lines: readonly ColoredLine[];
			width: number;
			opacity: number;
			dash: readonly [number, number];
	  }
	| { kind: 'polyline'; pts: readonly Pt[]; color: string; width: number; opacity: number }
	| {
			kind: 'circle';
			cx: number;
			cy: number;
			r: number;
			fill: string;
			stroke: string;
			strokeWidth: number;
	  };

export type SceneInputs = {
	stroke: number;
	// Ground
	terrainActive: boolean;
	hasGroundTexture: boolean;
	terrainOpacity: number;
	showMap: boolean;
	tileOpacity: number;
	hasTileImage: boolean;
	tileTransform: TileTransform | null;
	clipTriangles: readonly ClipTriangle[];
	terrainMesh: readonly (TriTransform | null)[];
	terrainOrder: readonly number[];
	terrainFaces: readonly TerrainFace[];
	blockFaces: readonly BlockFace[];
	// Route + furniture
	shadow: readonly Pt[];
	allDrapes: readonly DrapeColored[];
	externalHover: HoverHighlight;
	showAnchorLines: boolean;
	anchorLines: readonly AnchorLine[];
	boundaryAnchors: readonly BoundaryAnchor[];
	polylines: readonly PolylineRun[];
	ghostPolylines: readonly PolylineRun[];
	startEnd: { a: Projected | null; b: Projected | null } | null;
};

const FACE_FILL = '#f0e6d6';
const FACE_STROKE = '#d4c5ad';

export function buildScene(s: SceneInputs): SceneOp[] {
	const out: SceneOp[] = [];

	const facePolygon = (face: TerrainFace | BlockFace, opacity: number): SceneOp => ({
		kind: 'polygon',
		pts: face.verts,
		fill: FACE_FILL,
		stroke: FACE_STROKE,
		strokeWidth: 1,
		opacity
	});

	// Ground.
	if (s.terrainActive && s.hasGroundTexture) {
		// Back faces before the mesh, so a far valley can't bleed through the
		// near silhouette. Per-face opacity (they sit outside the mesh's
		// group-opacity layer).
		for (const face of s.terrainFaces) {
			if (!face.isFront) out.push(facePolygon(face, s.terrainOpacity));
		}
		out.push({
			kind: 'mesh',
			image: 'ground',
			triangles: s.terrainMesh,
			clips: s.clipTriangles,
			order: s.terrainOrder,
			opacity: s.terrainOpacity
		});
	} else {
		if (s.showMap && s.blockFaces.length > 0 && s.tileOpacity > 0.01) {
			for (const face of s.blockFaces) out.push(facePolygon(face, s.tileOpacity));
		}
		if (s.showMap && s.hasTileImage && s.tileTransform && s.tileOpacity > 0.01) {
			out.push({ kind: 'image', image: 'tile', m: s.tileTransform, opacity: s.tileOpacity });
		}
	}

	// Route shadow — flat mode only; the hillshaded mesh carries the depth
	// cue in terrain mode.
	if (s.shadow.length >= 2 && !s.terrainActive) {
		out.push({
			kind: 'polyline',
			pts: s.shadow,
			color: '#0f172a',
			width: s.stroke * 1.6,
			opacity: 0.16
		});
	}

	for (const d of s.allDrapes) {
		if (d.quads.length > 0) {
			out.push({ kind: 'quads', quads: d.quads, color: d.color, opacity: 0.22 });
		}
	}

	if (s.externalHover.quads.length > 0) {
		out.push({
			kind: 'quads',
			quads: s.externalHover.quads,
			color: s.externalHover.color,
			opacity: 0.3
		});
	}

	if (s.showAnchorLines) {
		if (s.anchorLines.length > 0) {
			out.push({
				kind: 'lines',
				lines: s.anchorLines.map((a) => ({ ...a, color: '#0f172a' })),
				width: 1.5,
				opacity: 0.12,
				dash: [3, 4]
			});
		}
		if (s.boundaryAnchors.length > 0) {
			out.push({
				kind: 'lines',
				lines: s.boundaryAnchors,
				width: 2.5,
				opacity: 0.65,
				dash: [5, 5]
			});
		}
	}

	// Solid route runs (already sorted back-to-front by depth).
	for (const line of s.polylines) {
		out.push({ kind: 'polyline', pts: line.pts, color: line.color, width: s.stroke, opacity: 1 });
	}

	if (s.externalHover.topPts.length >= 2) {
		out.push({
			kind: 'polyline',
			pts: s.externalHover.topPts,
			color: '#ffffff',
			width: s.stroke * 2.2,
			opacity: 0.55
		});
	}

	if (s.startEnd) {
		const dot = (p: Projected, fill: string): SceneOp => ({
			kind: 'circle',
			cx: p[0],
			cy: p[1],
			r: s.stroke * 1.6,
			fill,
			stroke: '#ffffff',
			strokeWidth: 3
		});
		if (s.startEnd.a) out.push(dot(s.startEnd.a, '#10b981'));
		if (s.startEnd.b) out.push(dot(s.startEnd.b, '#dc2626'));
	}

	// Front block faces AFTER the route and dots: the earth block is solid,
	// so route stretches whose screen position falls on a side wall are
	// swallowed by it — the visibility mask only knows the DEM surface.
	if (s.terrainActive) {
		for (const face of s.terrainFaces) {
			if (face.isFront) out.push(facePolygon(face, s.terrainOpacity));
		}
	}

	// Ghost above the walls AND the mesh; only the hover marker sits higher.
	for (const line of s.ghostPolylines) {
		out.push({
			kind: 'polyline',
			pts: line.pts,
			color: line.color,
			width: s.stroke,
			opacity: 0.22
		});
	}

	return out;
}
