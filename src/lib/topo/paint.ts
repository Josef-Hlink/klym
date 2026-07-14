// Canvas 2D executor for the scene ops built by scene.ts. This is this
// module's (single, policy-untested) DOM-touching function — everything
// above it (op order, styling, geometry) is pure and tested.
//
// Coordinates stay in viewBox units end-to-end: the view transform (from
// computeViewTransform — viewBox → device px, uniform scale) is baked into
// the context CTM, so lineWidth, dash patterns and radii are specified in
// viewBox units exactly like SVG stroke widths, and the CTM scales them.
//
// The terrain mesh is drawn into a persistent offscreen layer and
// composited at the op's opacity. That reproduces the SVG's group-opacity
// semantics (per-triangle alpha would double-darken the dilated seam
// overlaps into grid lines) and doubles as a cache: while the camera is
// still (hover-only repaints), re-rendering the frame is one blit instead
// of ~900 save/clip/drawImage/restore cycles.

import type { SceneOp } from './scene.js';
import type { ViewTransform } from './viewport.js';

export type PaintImages = { ground?: CanvasImageSource; tile?: CanvasImageSource };

// Offscreen terrain-mesh layer, owned by the component (one per canvas)
// and invalidated here by key comparison. All key parts are either
// reference-stable $derived outputs or plain numbers.
export type MeshCache = { canvas: HTMLCanvasElement | null; key: readonly unknown[] | null };

export function createMeshCache(): MeshCache {
	return { canvas: null, key: null };
}

function sameKey(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function finiteAffine(m: { a: number; b: number; c: number; d: number; e: number; f: number }) {
	return (
		Number.isFinite(m.a) &&
		Number.isFinite(m.b) &&
		Number.isFinite(m.c) &&
		Number.isFinite(m.d) &&
		Number.isFinite(m.e) &&
		Number.isFinite(m.f)
	);
}

function tracePolyline(ctx: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[]) {
	ctx.beginPath();
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}

function drawMeshLayer(
	layer: HTMLCanvasElement,
	op: Extract<SceneOp, { kind: 'mesh' }>,
	view: ViewTransform,
	image: CanvasImageSource
) {
	const ctx = layer.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, layer.width, layer.height);
	ctx.setTransform(view.k, 0, 0, view.k, view.tx, view.ty);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'medium';
	for (const i of op.order) {
		const m = op.triangles[i];
		const clip = op.clips[i];
		if (!m || !clip || !finiteAffine(m)) continue;
		ctx.save();
		// Path points are captured under the CTM at construction, so building
		// the clip AFTER the UV→screen transform specifies it in UV space —
		// the canvas equivalent of clip-path composing with the group matrix.
		ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
		const [p0, p1, p2] = clip.verts;
		ctx.beginPath();
		ctx.moveTo(p0[0], p0[1]);
		ctx.lineTo(p1[0], p1[1]);
		ctx.lineTo(p2[0], p2[1]);
		ctx.closePath();
		ctx.clip();
		// The texture mapped onto the UV unit square, like the SVG's
		// <image width=1 height=1 preserveAspectRatio=none>.
		ctx.drawImage(image, 0, 0, 1, 1);
		ctx.restore();
	}
}

export function renderScene(
	ctx: CanvasRenderingContext2D,
	ops: readonly SceneOp[],
	view: ViewTransform,
	images: PaintImages,
	cache: MeshCache
): void {
	const canvas = ctx.canvas;
	const devW = canvas.width;
	const devH = canvas.height;
	if (devW <= 0 || devH <= 0) return;
	if (!Number.isFinite(view.k) || !Number.isFinite(view.tx) || !Number.isFinite(view.ty)) return;

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, devW, devH);
	ctx.setTransform(view.k, 0, 0, view.k, view.tx, view.ty);
	// Smoothing state resets whenever the backing store is resized, so set
	// it per paint rather than once.
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'medium';
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	let hasMesh = false;
	for (const op of ops) {
		switch (op.kind) {
			case 'polygon': {
				if (op.pts.length < 3) break;
				ctx.globalAlpha = op.opacity;
				tracePolyline(ctx, op.pts);
				ctx.closePath();
				ctx.fillStyle = op.fill;
				ctx.fill();
				ctx.strokeStyle = op.stroke;
				ctx.lineWidth = op.strokeWidth;
				ctx.stroke();
				ctx.globalAlpha = 1;
				break;
			}
			case 'mesh': {
				hasMesh = true;
				const image = images[op.image];
				if (!image) break;
				const key = [op.triangles, op.clips, op.order, image, view.k, view.tx, view.ty, devW, devH];
				if (!cache.canvas || !sameKey(cache.key, key)) {
					cache.canvas ??= document.createElement('canvas');
					if (cache.canvas.width !== devW) cache.canvas.width = devW;
					if (cache.canvas.height !== devH) cache.canvas.height = devH;
					drawMeshLayer(cache.canvas, op, view, image);
					cache.key = key;
				}
				ctx.save();
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.globalAlpha = op.opacity;
				ctx.drawImage(cache.canvas, 0, 0);
				ctx.restore();
				break;
			}
			case 'image': {
				const image = images[op.image];
				if (!image || !finiteAffine(op.m)) break;
				ctx.save();
				ctx.globalAlpha = op.opacity;
				ctx.transform(op.m.a, op.m.b, op.m.c, op.m.d, op.m.e, op.m.f);
				ctx.drawImage(image, 0, 0, 1, 1);
				ctx.restore();
				break;
			}
			case 'quads': {
				// All quads as subpaths of ONE nonzero fill — overlap between
				// quads (switchbacks) must not accumulate alpha, same as the
				// single SVG <path>.
				ctx.globalAlpha = op.opacity;
				ctx.beginPath();
				for (const q of op.quads) {
					ctx.moveTo(q[0][0], q[0][1]);
					ctx.lineTo(q[1][0], q[1][1]);
					ctx.lineTo(q[2][0], q[2][1]);
					ctx.lineTo(q[3][0], q[3][1]);
					ctx.closePath();
				}
				ctx.fillStyle = op.color;
				ctx.fill('nonzero');
				ctx.globalAlpha = 1;
				break;
			}
			case 'lines': {
				ctx.globalAlpha = op.opacity;
				ctx.lineWidth = op.width;
				ctx.setLineDash(op.dash as [number, number]);
				for (const l of op.lines) {
					ctx.strokeStyle = l.color;
					ctx.beginPath();
					ctx.moveTo(l.x1, l.y1);
					ctx.lineTo(l.x2, l.y2);
					ctx.stroke();
				}
				ctx.setLineDash([]);
				ctx.globalAlpha = 1;
				break;
			}
			case 'polyline': {
				if (op.pts.length < 2) break;
				ctx.globalAlpha = op.opacity;
				ctx.strokeStyle = op.color;
				ctx.lineWidth = op.width;
				tracePolyline(ctx, op.pts);
				ctx.stroke();
				ctx.globalAlpha = 1;
				break;
			}
			case 'circle': {
				ctx.beginPath();
				ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
				ctx.fillStyle = op.fill;
				ctx.fill();
				ctx.strokeStyle = op.stroke;
				ctx.lineWidth = op.strokeWidth;
				ctx.stroke();
				break;
			}
		}
	}

	// Free the (device-sized, potentially tens of MB) layer when the mesh
	// isn't in the scene at all.
	if (!hasMesh && cache.canvas) {
		cache.canvas = null;
		cache.key = null;
	}
}
