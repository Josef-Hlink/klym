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

// How far the fingers' midpoint travels (CSS px) before the gesture
// commits to a mode. A clear pinch or twist commits sooner.
export const DECIDE_PX = 12;
// Grace window: a gesture that committed to 'transform' may still turn
// into a tilt while its midpoint has travelled no further than this. Real
// fingers rarely start together: the first one to move looks like a pan
// (or a small twist) before the second catches up.
export const TILT_GRACE_PX = 60;
// A tilt moves the midpoint mostly vertically: |dy| at least this many
// times |dx| …
const TILT_VERTICALITY = 1.2;
// … without the spread changing by more than this fraction (past it the
// gesture is a pinch, and commits at once).
const PINCH_COMMIT = 0.12;
// Twist dead zone: a pinch always twists a little, and a lagging finger
// looks like a twist; rotation only engages past this angle (≈ 10°), then
// follows the fingers from there.
export const TWIST_DEAD_ZONE = 0.17;

export type TwoFingerMode = 'undecided' | 'transform' | 'tilt';

/**
 * Decide what a two-finger gesture is from where each finger started and
 * where it is now, judged on the pair (midpoint travel, spread, angle) rather
 * than per finger, so a staggered start still reads as a slide. `allowTilt`
 * is false in 2D, where a vertical two-finger slide pans like any other.
 *
 * Twist vs a lagging finger: both change the pair's angle, but a twist turns
 * the fingers about a midpoint that stays put, while a slide with one finger
 * behind carries the midpoint along. So a vertical slide counts as a tilt as
 * long as the midpoint has travelled further than the arc the angle change
 * sweeps at the fingertips.
 */
export function classifyTwoFinger(
	start: [Pt, Pt],
	now: [Pt, Pt],
	allowTilt: boolean
): TwoFingerMode {
	const f0 = pairFrame(start[0], start[1]);
	const f1 = pairFrame(now[0], now[1]);
	const dx = f1.cx - f0.cx;
	const dy = f1.cy - f0.cy;
	const pinch = f0.dist > 0 ? Math.abs(f1.dist - f0.dist) / f0.dist : 0;
	const twist = Math.abs(angleDelta(f0.angle, f1.angle));
	const travel = Math.hypot(dx, dy);
	if (pinch > PINCH_COMMIT) return 'transform';
	if (travel < DECIDE_PX) return twist > TWIST_DEAD_ZONE ? 'transform' : 'undecided';
	if (!allowTilt) return 'transform';
	const arc = (twist * f0.dist) / 2;
	const vertical = Math.abs(dy) >= TILT_VERTICALITY * Math.abs(dx);
	return vertical && arc < travel ? 'tilt' : 'transform';
}

/**
 * The grace window: re-judge a gesture that went to 'transform' while its
 * midpoint is still within TILT_GRACE_PX of where it started. Once it looks
 * like a tilt — fingers level again, no pinch, moving vertically — it
 * becomes one, and the caller undoes the pan, zoom and any rotation the
 * staggered start already applied. Never leaves 'tilt'.
 */
export function regradeTwoFinger(
	start: [Pt, Pt],
	now: [Pt, Pt],
	allowTilt: boolean,
	mode: TwoFingerMode
): TwoFingerMode {
	if (mode !== 'transform' || !allowTilt) return mode;
	const f0 = pairFrame(start[0], start[1]);
	const f1 = pairFrame(now[0], now[1]);
	if (Math.hypot(f1.cx - f0.cx, f1.cy - f0.cy) > TILT_GRACE_PX) return mode;
	return classifyTwoFinger(start, now, true) === 'tilt' ? 'tilt' : mode;
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
