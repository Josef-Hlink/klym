import { describe, it, expect } from 'vitest';
import type {
	AnchorLine,
	BlockFace,
	BoundaryAnchor,
	DrapeColored,
	HoverHighlight,
	PolylineRun,
	ShadowPoints
} from './geometry.js';
import { buildScene, type SceneInputs, type SceneOp } from './scene.js';
import type { ClipTriangle, TerrainFace, TriTransform } from './terrain.js';

// Minimal fixtures — the scene builder never inspects coordinates, only
// counts/flags, so tiny synthetic shapes are enough.
const P = (x: number, y: number): [number, number] => [x, y];
const IDENT: TriTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const clipTriangles: ClipTriangle[] = [
	{ d: 'M 0 0 L 1 0 L 0 1 Z', verts: [P(0, 0), P(1, 0), P(0, 1)] },
	{ d: 'M 1 0 L 1 1 L 0 1 Z', verts: [P(1, 0), P(1, 1), P(0, 1)] }
];
const terrainMesh: (TriTransform | null)[] = [IDENT, IDENT];
const terrainOrder = [0, 1];

const face = (isFront: boolean, depth: number): TerrainFace => ({
	points: '0,0 1,0 1,1',
	verts: [P(0, 0), P(1, 0), P(1, 1)],
	depth,
	isFront
});
const terrainFaces: TerrainFace[] = [face(false, 0), face(false, 1), face(true, 2), face(true, 3)];

const blockFaces: BlockFace[] = [
	{ points: '0,0 1,0 1,1 0,1', verts: [P(0, 0), P(1, 0), P(1, 1), P(0, 1)], depth: 0 }
];

const run = (color: string): PolylineRun => ({
	points: '0,0 10,10',
	pts: [P(0, 0), P(10, 10)],
	color,
	depth: 0
});

const shadow: ShadowPoints = { points: '0,0 10,10', pts: [P(0, 0), P(10, 10)] };
const emptyShadow: ShadowPoints = { points: '', pts: [] };

const quad: [ReturnType<typeof P>, ReturnType<typeof P>, ReturnType<typeof P>, ReturnType<typeof P>] = [
	P(0, 0),
	P(1, 0),
	P(1, 1),
	P(0, 1)
];
const drapes: DrapeColored[] = [
	{ drape: 'M...Z', quads: [quad], color: '#e00' },
	{ drape: 'M...Z', quads: [quad], color: '#0e0' }
];

const hover: HoverHighlight = {
	polyline: '0,0 10,10',
	topPts: [P(0, 0), P(10, 10)],
	drape: 'M...Z',
	quads: [quad],
	color: '#abc'
};
const emptyHover: HoverHighlight = { polyline: '', topPts: [], drape: '', quads: [], color: '' };

const anchorLines: AnchorLine[] = [{ x1: 0, y1: 0, x2: 0, y2: 5 }];
const boundaryAnchors: BoundaryAnchor[] = [{ x1: 1, y1: 0, x2: 1, y2: 5, color: '#f00' }];

const baseInputs: SceneInputs = {
	stroke: 6,
	terrainActive: false,
	hasGroundTexture: false,
	terrainOpacity: 1,
	showMap: true,
	tileOpacity: 1,
	hasTileImage: true,
	tileTransform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
	clipTriangles: [],
	terrainMesh: [],
	terrainOrder: [],
	terrainFaces: [],
	blockFaces,
	shadow,
	allDrapes: [],
	externalHover: emptyHover,
	showAnchorLines: true,
	anchorLines,
	boundaryAnchors,
	polylines: [run('#111'), run('#222')],
	ghostPolylines: [],
	startEnd: { a: [0, 0, 0], b: [10, 10, 0] }
};

const terrainInputs: SceneInputs = {
	...baseInputs,
	terrainActive: true,
	hasGroundTexture: true,
	terrainOpacity: 0.7,
	clipTriangles,
	terrainMesh,
	terrainOrder,
	terrainFaces,
	ghostPolylines: [run('#333')]
};

const kinds = (ops: SceneOp[]) => ops.map((o) => o.kind);
const indicesOf = (ops: SceneOp[], pred: (o: SceneOp) => boolean) =>
	ops.map((o, i) => (pred(o) ? i : -1)).filter((i) => i >= 0);

describe('buildScene — flat mode', () => {
	it('paints ground → shadow → anchors → solid runs → dots, no terrain ops', () => {
		const ops = buildScene(baseInputs);
		expect(kinds(ops)).toEqual([
			'polygon', // block face
			'image', // tile parallelogram
			'polyline', // shadow
			'lines', // thin anchors
			'lines', // boundary anchors
			'polyline', // solid run 1
			'polyline', // solid run 2
			'circle', // start dot
			'circle' // end dot
		]);
	});

	it('showMap=false drops the ground ops but keeps the shadow', () => {
		const ops = buildScene({ ...baseInputs, showMap: false });
		expect(ops.some((o) => o.kind === 'image' || o.kind === 'polygon')).toBe(false);
		const shadowOps = ops.filter((o) => o.kind === 'polyline' && o.opacity === 0.16);
		expect(shadowOps).toHaveLength(1);
	});

	it('tileOpacity ≤ 0.01 drops tile and block faces (edge-on fade)', () => {
		const ops = buildScene({ ...baseInputs, tileOpacity: 0.005 });
		expect(ops.some((o) => o.kind === 'image' || o.kind === 'polygon')).toBe(false);
	});

	it('shadow styling matches the SVG template', () => {
		const ops = buildScene(baseInputs);
		const s = ops.find((o) => o.kind === 'polyline' && o.opacity === 0.16)!;
		expect(s).toMatchObject({ color: '#0f172a', width: 6 * 1.6 });
	});

	it('no shadow op when the shadow is empty', () => {
		const ops = buildScene({ ...baseInputs, shadow: emptyShadow });
		expect(ops.some((o) => o.kind === 'polyline' && o.opacity === 0.16)).toBe(false);
	});
});

describe('buildScene — terrain mode (the occlusion interleave)', () => {
	it('LOCK: solid runs < endpoint dots < front faces < ghost runs', () => {
		const ops = buildScene(terrainInputs);
		const solid = indicesOf(ops, (o) => o.kind === 'polyline' && o.opacity === 1);
		const dots = indicesOf(ops, (o) => o.kind === 'circle');
		const ghosts = indicesOf(ops, (o) => o.kind === 'polyline' && o.opacity === 0.22);
		// Front faces are the polygon ops after the mesh op.
		const meshIdx = ops.findIndex((o) => o.kind === 'mesh');
		const frontIdx = indicesOf(ops, (o) => o.kind === 'polygon').filter((i) => i > meshIdx);

		expect(solid.length).toBeGreaterThan(0);
		expect(dots.length).toBe(2);
		expect(frontIdx.length).toBe(2);
		expect(ghosts.length).toBeGreaterThan(0);
		expect(Math.max(...solid)).toBeLessThan(Math.min(...dots));
		expect(Math.max(...dots)).toBeLessThan(Math.min(...frontIdx));
		expect(Math.max(...frontIdx)).toBeLessThan(Math.min(...ghosts));
	});

	it('back faces precede the mesh op; front faces do not appear before it', () => {
		const ops = buildScene(terrainInputs);
		const meshIdx = ops.findIndex((o) => o.kind === 'mesh');
		const polysBefore = indicesOf(ops, (o) => o.kind === 'polygon').filter((i) => i < meshIdx);
		expect(polysBefore).toHaveLength(2); // the two back faces
		expect(meshIdx).toBeGreaterThan(-1);
	});

	it('no shadow op in terrain mode even when shadow points exist', () => {
		const ops = buildScene(terrainInputs);
		expect(ops.some((o) => o.kind === 'polyline' && o.opacity === 0.16)).toBe(false);
	});

	it('no flat-ground image op in terrain mode', () => {
		expect(buildScene(terrainInputs).some((o) => o.kind === 'image')).toBe(false);
	});

	it('mesh op passes triangles/clips/order through by reference at terrainOpacity', () => {
		const ops = buildScene(terrainInputs);
		const mesh = ops.find((o) => o.kind === 'mesh')!;
		expect(mesh.kind === 'mesh' && mesh.triangles).toBe(terrainMesh);
		expect(mesh.kind === 'mesh' && mesh.clips).toBe(clipTriangles);
		expect(mesh.kind === 'mesh' && mesh.order).toBe(terrainOrder);
		expect(mesh.kind === 'mesh' && mesh.opacity).toBe(0.7);
		expect(mesh.kind === 'mesh' && mesh.image).toBe('ground');
	});

	it('every face polygon carries its own terrainOpacity (per-element semantics)', () => {
		const ops = buildScene(terrainInputs);
		for (const o of ops) {
			if (o.kind === 'polygon') expect(o.opacity).toBe(0.7);
		}
	});

	it('ghost runs use width=stroke and opacity 0.22', () => {
		const ops = buildScene(terrainInputs);
		const ghost = ops.find((o) => o.kind === 'polyline' && o.opacity === 0.22)!;
		expect(ghost).toMatchObject({ width: 6, color: '#333' });
	});
});

describe('buildScene — anchors, drapes, hover, dots', () => {
	it('showAnchorLines=false drops both anchor passes', () => {
		const ops = buildScene({ ...baseInputs, showAnchorLines: false });
		expect(ops.some((o) => o.kind === 'lines')).toBe(false);
	});

	it('thin pass before boundary pass, both before solid runs, with template styling', () => {
		const ops = buildScene(baseInputs);
		const lines = indicesOf(ops, (o) => o.kind === 'lines');
		const solid = indicesOf(ops, (o) => o.kind === 'polyline' && o.opacity === 1);
		expect(lines).toHaveLength(2);
		expect(Math.max(...lines)).toBeLessThan(Math.min(...solid));
		const [thin, boundary] = lines.map((i) => ops[i]) as Extract<SceneOp, { kind: 'lines' }>[];
		expect(thin).toMatchObject({ width: 1.5, opacity: 0.12, dash: [3, 4] });
		expect(thin.lines[0].color).toBe('#0f172a');
		expect(boundary).toMatchObject({ width: 2.5, opacity: 0.65, dash: [5, 5] });
		expect(boundary.lines[0].color).toBe('#f00');
	});

	it('drapes at 0.22, hover drape at 0.3 and after them; halo after solids, before dots', () => {
		const ops = buildScene({ ...baseInputs, allDrapes: drapes, externalHover: hover });
		const drapeIdx = indicesOf(ops, (o) => o.kind === 'quads' && o.opacity === 0.22);
		const hoverDrapeIdx = indicesOf(ops, (o) => o.kind === 'quads' && o.opacity === 0.3);
		expect(drapeIdx).toHaveLength(2);
		expect(hoverDrapeIdx).toHaveLength(1);
		expect(Math.max(...drapeIdx)).toBeLessThan(hoverDrapeIdx[0]);

		const solid = indicesOf(ops, (o) => o.kind === 'polyline' && o.opacity === 1);
		const halo = indicesOf(ops, (o) => o.kind === 'polyline' && o.opacity === 0.55);
		const dots = indicesOf(ops, (o) => o.kind === 'circle');
		expect(halo).toHaveLength(1);
		expect(Math.max(...solid)).toBeLessThan(halo[0]);
		expect(halo[0]).toBeLessThan(Math.min(...dots));
		const haloOp = ops[halo[0]] as Extract<SceneOp, { kind: 'polyline' }>;
		expect(haloOp).toMatchObject({ color: '#ffffff', width: 6 * 2.2 });
	});

	it('per-end nulling of startEnd yields the matching circle subset', () => {
		const onlyB = buildScene({ ...baseInputs, startEnd: { a: null, b: [10, 10, 0] } });
		const circles = onlyB.filter((o) => o.kind === 'circle');
		expect(circles).toHaveLength(1);
		expect(circles[0]).toMatchObject({ fill: '#dc2626' });

		const onlyA = buildScene({ ...baseInputs, startEnd: { a: [0, 0, 0], b: null } });
		expect(onlyA.filter((o) => o.kind === 'circle')[0]).toMatchObject({ fill: '#10b981' });

		const none = buildScene({ ...baseInputs, startEnd: null });
		expect(none.some((o) => o.kind === 'circle')).toBe(false);
	});

	it('dot styling matches the template (r = stroke·1.6, white ring w3)', () => {
		const ops = buildScene(baseInputs);
		const dot = ops.find((o) => o.kind === 'circle')!;
		expect(dot).toMatchObject({ r: 6 * 1.6, stroke: '#ffffff', strokeWidth: 3 });
	});
});

describe('buildScene — empty inputs', () => {
	it('returns [] when nothing is drawable', () => {
		const ops = buildScene({
			...baseInputs,
			showMap: false,
			shadow: emptyShadow,
			anchorLines: [],
			boundaryAnchors: [],
			polylines: [],
			startEnd: null
		});
		expect(ops).toEqual([]);
	});
});
