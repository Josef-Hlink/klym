// Viewport math for the segment topo view's pan/zoom interaction.
//
// The viewport is the rectangle in viewBox space the painter is currently
// showing. At rest it equals the canvas dimensions; pan moves it around;
// wheel-zoom shrinks or enlarges it around the cursor. Clamping keeps the
// viewport within a margin around the canvas so rotated/tilted geometry
// that overflows the original box stays reachable.
//
// All exports are pure — no DOM, no reactive state. The component owns the
// `viewport` state and the event handlers; it calls in here for the math.

import type { Dimensions } from './projection.js';

// Wheel-zoom step. Factor < 1 means a single tick zooms IN by that ratio
// (viewport shrinks); the inverse zooms out. 0.85 is one fairly chunky
// step per wheel notch — feels responsive without overshooting.
export const ZOOM_FACTOR = 0.85;

// Min/max viewport size as a fraction of the natural canvas width. Below
// MIN you're zoomed in past usefulness; above MAX you've zoomed so far out
// the route is a dot in a sea of margin.
export const MIN_VIEW_FRAC = 0.05;
export const MAX_VIEW_FRAC = 3;

// Pan-margin: how much past each edge of the natural canvas the user can
// pan, expressed as a fraction of the canvas size. Half a canvas worth of
// overshoot lets rotated/tilted geometry that pokes outside the original
// box stay reachable.
export const PAN_MARGIN_FRAC = 0.5;

// Threshold (in viewBox units) below which we consider the viewport
// "equal" to the natural canvas dimensions — used by isZoomed and by the
// reset-view button visibility check.
const VIEWPORT_EQUAL_TOLERANCE = 0.5;

export type Viewport = { x: number; y: number; w: number; h: number };

// Default viewport — the natural canvas covering the whole SVG.
export function defaultViewport(dimensions: Dimensions): Viewport {
	return { x: 0, y: 0, w: dimensions.W, h: dimensions.H };
}

// Clamp a viewport's (x, y) so it stays within `marginFraction` past each
// edge of the natural canvas. If the viewport already covers natural+margin
// (very zoomed out) it gets centred on the canvas instead.
export function clampViewport(
	v: Viewport,
	dimensions: Dimensions,
	marginFraction: number = PAN_MARGIN_FRAC
): Viewport {
	const marginX = dimensions.W * marginFraction;
	const marginY = dimensions.H * marginFraction;
	const minX = -marginX;
	const maxX = dimensions.W + marginX - v.w;
	const minY = -marginY;
	const maxY = dimensions.H + marginY - v.h;
	const x =
		maxX < minX ? (dimensions.W - v.w) / 2 : Math.max(minX, Math.min(maxX, v.x));
	const y =
		maxY < minY ? (dimensions.H - v.h) / 2 : Math.max(minY, Math.min(maxY, v.y));
	return { x, y, w: v.w, h: v.h };
}

// Zoom around a cursor position expressed as a fraction of the SVG's CSS
// rect (relX, relY ∈ [0, 1]). The world-space point under the cursor stays
// pinned through the transform — that's the "zoom into where I'm looking"
// feel. Width is clamped to [MIN_VIEW_FRAC, MAX_VIEW_FRAC] of dimensions.W;
// height scales by the actually-applied factor so aspect is preserved.
// The result is run through `clampViewport` so the (x, y) doesn't drift
// outside the pan margin.
export function applyZoomAtCursor(
	viewport: Viewport,
	dimensions: Dimensions,
	relX: number,
	relY: number,
	wheelDeltaY: number,
	minViewFrac: number = MIN_VIEW_FRAC,
	maxViewFrac: number = MAX_VIEW_FRAC,
	zoomFactor: number = ZOOM_FACTOR
): Viewport {
	const cursorSvgX = viewport.x + relX * viewport.w;
	const cursorSvgY = viewport.y + relY * viewport.h;
	const factor = wheelDeltaY < 0 ? zoomFactor : 1 / zoomFactor;
	const minW = dimensions.W * minViewFrac;
	const maxW = dimensions.W * maxViewFrac;
	const newW = Math.max(minW, Math.min(maxW, viewport.w * factor));
	const actualFactor = newW / viewport.w;
	const newH = viewport.h * actualFactor;
	const newX = cursorSvgX - relX * newW;
	const newY = cursorSvgY - relY * newH;
	return clampViewport({ x: newX, y: newY, w: newW, h: newH }, dimensions);
}

// True when the viewport has been moved or resized away from the natural
// canvas (the at-rest state). Tolerant of sub-pixel float drift so a
// no-op pan/zoom doesn't keep the reset-view button stuck on.
export function isZoomedOrPanned(
	viewport: Viewport | null,
	dimensions: Dimensions
): boolean {
	if (viewport == null) return false;
	return (
		Math.abs(viewport.x) > VIEWPORT_EQUAL_TOLERANCE ||
		Math.abs(viewport.y) > VIEWPORT_EQUAL_TOLERANCE ||
		Math.abs(viewport.w - dimensions.W) > VIEWPORT_EQUAL_TOLERANCE ||
		Math.abs(viewport.h - dimensions.H) > VIEWPORT_EQUAL_TOLERANCE
	);
}

// The painter's view transform — what SVG's `viewBox` +
// preserveAspectRatio "xMidYMid meet" did: a uniform scale k and
// translation mapping viewBox coordinates to device pixels on a
// cssW×cssH canvas at the given devicePixelRatio. Null viewport falls
// back to the natural canvas; degenerate sizes return null (skip the
// paint).
export type ViewTransform = { k: number; tx: number; ty: number };

export function computeViewTransform(
	viewport: Viewport | null,
	dimensions: Dimensions,
	cssW: number,
	cssH: number,
	dpr: number
): ViewTransform | null {
	const v = viewport ?? defaultViewport(dimensions);
	const devW = cssW * dpr;
	const devH = cssH * dpr;
	if (!(devW > 0) || !(devH > 0) || !(v.w > 0) || !(v.h > 0)) return null;
	const k = Math.min(devW / v.w, devH / v.h);
	if (!Number.isFinite(k) || k <= 0) return null;
	const tx = (devW - v.w * k) / 2 - v.x * k;
	const ty = (devH - v.h * k) / 2 - v.y * k;
	return { k, tx, ty };
}
