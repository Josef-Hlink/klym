import { describe, expect, it } from 'vitest';
import {
	angleDelta,
	classifyTwoFinger,
	pairFrame,
	regradeTwoFinger,
	TILT_GRACE_PX,
	pinchViewport,
	twistYaw,
	type Pt
} from './touch.js';
import { MAX_VIEW_FRAC, MIN_VIEW_FRAC } from './viewport.js';
import type { Dimensions } from './projection.js';

const dims: Dimensions = { W: 1600, H: 800, innerW: 1536, innerH: 736, scale: 1 };
const vp = { x: 0, y: 0, w: 1600, h: 800 };

describe('pairFrame', () => {
	it('gives midpoint, spread and angle', () => {
		const f = pairFrame({ x: 0, y: 0 }, { x: 10, y: 0 });
		expect(f).toEqual({ cx: 5, cy: 0, dist: 10, angle: 0 });
		expect(pairFrame({ x: 0, y: 0 }, { x: 0, y: 10 }).angle).toBeCloseTo(Math.PI / 2);
	});
});

describe('angleDelta', () => {
	it('wraps across ±π', () => {
		expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
		expect(angleDelta(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2);
		expect(angleDelta(0, 0.5)).toBeCloseTo(0.5);
	});
});

describe('classifyTwoFinger', () => {
	const start: [Pt, Pt] = [
		{ x: 100, y: 100 },
		{ x: 200, y: 100 }
	];
	const move = (dx0: number, dy0: number, dx1: number, dy1: number): [Pt, Pt] => [
		{ x: 100 + dx0, y: 100 + dy0 },
		{ x: 200 + dx1, y: 100 + dy1 }
	];

	it('waits until the midpoint has moved far enough', () => {
		expect(classifyTwoFinger(start, move(3, 3, -2, 4), true)).toBe('undecided');
	});
	it('reads a parallel vertical slide as tilt in 3D', () => {
		expect(classifyTwoFinger(start, move(2, -30, -1, -28), true)).toBe('tilt');
	});
	it('reads a staggered vertical slide (one finger lagging) as tilt', () => {
		// the second finger is a few px behind: per-finger rules saw two
		// different motions and called it a pan
		expect(classifyTwoFinger(start, move(1, -20, 0, -8), true)).toBe('tilt');
	});
	it('never tilts in 2D', () => {
		expect(classifyTwoFinger(start, move(2, -30, -1, -28), false)).toBe('transform');
	});
	it('reads a pinch as transform', () => {
		expect(classifyTwoFinger(start, move(-20, 0, 20, 0), true)).toBe('transform');
	});
	it('reads a vertical pinch (fingers apart) as transform', () => {
		const s: [Pt, Pt] = [
			{ x: 100, y: 100 },
			{ x: 100, y: 200 }
		];
		const n: [Pt, Pt] = [
			{ x: 100, y: 70 },
			{ x: 100, y: 230 }
		];
		expect(classifyTwoFinger(s, n, true)).toBe('transform');
	});
	it('reads a twist as transform', () => {
		expect(classifyTwoFinger(start, move(0, -25, 0, 25), true)).toBe('transform');
	});
	it('reads a sideways slide as transform', () => {
		expect(classifyTwoFinger(start, move(30, 2, 30, 1), true)).toBe('transform');
	});
});

describe('regradeTwoFinger', () => {
	const start: [Pt, Pt] = [
		{ x: 100, y: 100 },
		{ x: 200, y: 100 }
	];
	const at = (dx: number, dy: number): [Pt, Pt] => [
		{ x: 100 + dx, y: 100 + dy },
		{ x: 200 + dx, y: 100 + dy }
	];

	it('turns an early pan into a tilt once the slide is clearly vertical', () => {
		// committed as a pan after a sideways-ish start …
		expect(classifyTwoFinger(start, at(12, -6), true)).toBe('transform');
		// … then the fingers carry on upward
		expect(regradeTwoFinger(start, at(12, -40), true, 'transform')).toBe('tilt');
	});
	it('recovers a tilt whose lagging finger first read as a twist', () => {
		// right at the start, B hasn't moved: angle changed, midpoint barely
		const early: [Pt, Pt] = [
			{ x: 100, y: 82 },
			{ x: 200, y: 100 }
		];
		expect(classifyTwoFinger(start, early, true)).toBe('transform');
		// B follows 30px behind; the midpoint has now clearly gone up
		const later: [Pt, Pt] = [
			{ x: 100, y: 50 },
			{ x: 200, y: 80 }
		];
		expect(regradeTwoFinger(start, later, true, 'transform')).toBe('tilt');
	});
	it('stops re-judging past the grace window', () => {
		expect(regradeTwoFinger(start, at(5, -(TILT_GRACE_PX + 10)), true, 'transform')).toBe(
			'transform'
		);
	});
	it('keeps a real twist a transform', () => {
		const twisted: [Pt, Pt] = [
			{ x: 100, y: 75 },
			{ x: 200, y: 125 }
		];
		expect(regradeTwoFinger(start, twisted, true, 'transform')).toBe('transform');
	});
	it('does nothing in 2D', () => {
		expect(regradeTwoFinger(start, at(0, -40), false, 'transform')).toBe('transform');
	});
	it('never leaves tilt', () => {
		expect(regradeTwoFinger(start, at(40, 0), true, 'tilt')).toBe('tilt');
	});
});

describe('pinchViewport', () => {
	it('is the identity for an unmoved pair', () => {
		const v = pinchViewport(vp, dims, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 100, 100);
		expect(v).toEqual(vp);
	});
	it('keeps the world point under the midpoint pinned while zooming in', () => {
		const rel0 = { x: 0.25, y: 0.75 };
		const v = pinchViewport(vp, dims, rel0, rel0, 100, 200);
		expect(v.w).toBeCloseTo(800);
		expect(v.h).toBeCloseTo(400);
		// world under the midpoint before == after
		expect(v.x + rel0.x * v.w).toBeCloseTo(vp.x + rel0.x * vp.w);
		expect(v.y + rel0.y * v.h).toBeCloseTo(vp.y + rel0.y * vp.h);
	});
	it('pans with the midpoint at constant spread', () => {
		const v = pinchViewport(vp, dims, { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, 100, 100);
		// fingers moved right by 10% of the canvas → the view moved left by 160 units
		expect(v.x).toBeCloseTo(-160);
		expect(v.w).toBe(1600);
	});
	it('clamps zoom to the wheel-zoom band', () => {
		const tight = pinchViewport(vp, dims, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 1, 1000);
		expect(tight.w).toBeCloseTo(dims.W * MIN_VIEW_FRAC);
		const wide = pinchViewport(vp, dims, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 1000, 1);
		expect(wide.w).toBeCloseTo(dims.W * MAX_VIEW_FRAC);
	});
});

describe('twistYaw', () => {
	it('turns yaw against a clockwise (screen) twist', () => {
		expect(twistYaw(0, 0, 0.3)).toBeCloseTo(-0.3);
		expect(twistYaw(1, 0.2, 0.1)).toBeCloseTo(1.1);
	});
});
