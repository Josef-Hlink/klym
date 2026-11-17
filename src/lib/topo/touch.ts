// Two-finger gesture math for the topo view on a touch screen.
//
// One finger belongs to the page (vertical swipes scroll it) and to the
// route readout (a tap or a sideways drag scrubs the route). Two fingers
// move the camera, Google-Maps style:
//   - pinch zooms around the fingers' midpoint, and moving the midpoint pans
//     (the world point under the midpoint stays under it),
//   - twisting past a small dead zone turns the yaw,
//   - in 3D, both fingers sliding up/down together (no pinch) tilts.
// The gesture locks into 'transform' or 'tilt' once the fingers have moved
// far enough to tell, so a tilt never pans and a pan never tilts.
//
// Pure: no DOM. The component feeds client coordinates in and applies the
// returned numbers to its viewport/yaw/pitch state.

import { clampViewport, MAX_VIEW_FRAC, MIN_VIEW_FRAC, type Viewport } from './viewport.js';
import type { Dimensions } from './projection.js';

export type Pt = { x: number; y: number };

/** The pair's midpoint, spread and angle (radians, screen y down). */
export type PairFrame = { cx: number; cy: number; dist: number; angle: number };

export function pairFrame(a: Pt, b: Pt): PairFrame {
	return {
		cx: (a.x + b.x) / 2,
		cy: (a.y + b.y) / 2,
		dist: Math.hypot(b.x - a.x, b.y - a.y),
		angle: Math.atan2(b.y - a.y, b.x - a.x)
	};
}

/** Smallest signed difference b − a between two angles, in (−π, π]. */
export function angleDelta(a: number, b: number): number {
	let d = b - a;
	while (d <= -Math.PI) d += 2 * Math.PI;
	while (d > Math.PI) d -= 2 * Math.PI;
	return d;
}

// Movement (CSS px, the larger of the two fingers) before the gesture
// commits to a mode.
export const DECIDE_PX = 10;
// A tilt is two fingers moving mostly vertically, the same way, without
// pinching: each finger's |dy| at least this many times its |dx| …
const TILT_VERTICALITY = 1.5;
// … and the spread changing by less than this fraction.
const TILT_MAX_PINCH = 0.15;
// Twist dead zone: a pinch always twists a little; rotation only engages
// past this angle (≈ 10°), then follows the fingers from there.
export const TWIST_DEAD_ZONE = 0.17;

export type TwoFingerMode = 'undecided' | 'transform' | 'tilt';

/**
 * Decide what a two-finger gesture is from where each finger started and
 * where it is now. `allowTilt` is false in 2D, where a vertical two-finger
 * slide pans like any other.
 */
export function classifyTwoFinger(
	start: [Pt, Pt],
	now: [Pt, Pt],
	allowTilt: boolean
): TwoFingerMode {
	const d0 = { x: now[0].x - start[0].x, y: now[0].y - start[0].y };
	const d1 = { x: now[1].x - start[1].x, y: now[1].y - start[1].y };
	const moved = Math.max(Math.hypot(d0.x, d0.y), Math.hypot(d1.x, d1.y));
	if (moved < DECIDE_PX) return 'undecided';
	if (!allowTilt) return 'transform';
	const f0 = pairFrame(start[0], start[1]);
	const f1 = pairFrame(now[0], now[1]);
	const pinch = f0.dist > 0 ? Math.abs(f1.dist - f0.dist) / f0.dist : 0;
	const vertical = (d: Pt) => Math.abs(d.y) >= TILT_VERTICALITY * Math.abs(d.x);
	const sameWay = Math.sign(d0.y) === Math.sign(d1.y) && d0.y !== 0;
	return vertical(d0) && vertical(d1) && sameWay && pinch < TILT_MAX_PINCH ? 'tilt' : 'transform';
}

/**
 * Pinch-zoom + pan: the viewport that keeps the world point that was under
 * the starting midpoint under the current one, scaled by the spread ratio.
 * Midpoints are fractions (0..1) of the canvas's on-screen rect. Width is
 * clamped to the same [MIN_VIEW_FRAC, MAX_VIEW_FRAC] band as wheel zoom.
 */
export function pinchViewport(
	vp0: Viewport,
	dimensions: Dimensions,
	rel0: Pt,
	rel: Pt,
	dist0: number,
	dist: number
): Viewport {
	const scale = dist > 0 && dist0 > 0 ? dist0 / dist : 1;
	const minW = dimensions.W * MIN_VIEW_FRAC;
	const maxW = dimensions.W * MAX_VIEW_FRAC;
	const w = Math.max(minW, Math.min(maxW, vp0.w * scale));
	const h = vp0.h * (w / vp0.w);
	const worldX = vp0.x + rel0.x * vp0.w;
	const worldY = vp0.y + rel0.y * vp0.h;
	return clampViewport({ x: worldX - rel.x * w, y: worldY - rel.y * h, w, h }, dimensions);
}

/**
 * Yaw for a twist. Screen angles grow clockwise (y down) while yaw turns the
 * world counter-clockwise on screen, so the map follows the fingers when yaw
 * moves against the angle.
 */
export function twistYaw(yawAtEngage: number, angleAtEngage: number, angle: number): number {
	return yawAtEngage - angleDelta(angleAtEngage, angle);
}
