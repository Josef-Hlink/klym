import { describe, it, expect } from 'vitest';
import {
	DETECTION_PRESETS,
	categoryColor,
	climbCategory,
	detectClimbs,
	fietsIndex
} from './climbs.js';
import type { RoutePoint } from './types.js';

// Synthetic route builder: a sequence of constant-grade legs, sampled every
// `stepM`. Detection only reads ele/cumDistM, so lat/lon stay fixed.
function legsRoute(legs: { lenM: number; grade: number }[], stepM = 20): RoutePoint[] {
	const pts: RoutePoint[] = [{ lat: 45, lon: 5, ele: 100, cumDistM: 0 }];
	let dist = 0;
	let ele = 100;
	for (const leg of legs) {
		const end = dist + leg.lenM;
		while (dist < end) {
			const d = Math.min(stepM, end - dist);
			dist += d;
			ele += (d * leg.grade) / 100;
			pts.push({ lat: 45, lon: 5, ele, cumDistM: dist });
		}
	}
	return pts;
}

describe('detectClimbs', () => {
	it('returns [] for empty and trivially short input', () => {
		expect(detectClimbs([])).toEqual([]);
		expect(detectClimbs([{ lat: 45, lon: 5, ele: 100, cumDistM: 0 }])).toEqual([]);
		expect(detectClimbs(legsRoute([{ lenM: 100, grade: 10 }]))).toEqual([]);
	});

	it('finds nothing on a flat route', () => {
		expect(detectClimbs(legsRoute([{ lenM: 10000, grade: 0 }]))).toEqual([]);
	});

	it('finds nothing on a pure descent', () => {
		expect(detectClimbs(legsRoute([{ lenM: 5000, grade: -6 }]))).toEqual([]);
	});

	it('detects a single clean climb with correct bounds and stats', () => {
		const route = legsRoute([
			{ lenM: 2000, grade: 0 },
			{ lenM: 5000, grade: 8 },
			{ lenM: 2000, grade: 0 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		const c = climbs[0];
		// Smoothing blurs the transitions, so allow slack around the true edges.
		expect(c.startM).toBeGreaterThan(1800);
		expect(c.startM).toBeLessThan(2200);
		expect(c.endM).toBeGreaterThan(6800);
		expect(c.endM).toBeLessThan(7200);
		expect(c.gainM).toBeGreaterThan(380);
		expect(c.gainM).toBeLessThan(405);
		expect(c.avgGrade).toBeGreaterThan(7.4);
		expect(c.avgGrade).toBeLessThan(8.3);
		expect(c.maxGrade).toBeGreaterThan(7.4);
		expect(c.maxGrade).toBeLessThan(8.5);
		expect(c.topEleM).toBeCloseTo(500, 0);
		// score ≈ 400 m gain × 100 → comfortably category 2.
		expect(c.category).toBe('2');
	});

	it('bridges a false flat seamlessly — one climb, no parts', () => {
		// A short, near-lossless breather is tier 1: the climb never really
		// stopped, so it must not grow a parts expander.
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 200, grade: -1 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].lengthM).toBeGreaterThan(5900);
		expect(climbs[0].parts).toBeUndefined();
	});

	it('joins two climbs across a real dip and exposes them as parts', () => {
		// 800 m at -5% is too long/lossy for tier 1, but both sides qualify
		// on their own, so tier 2 composes A, B, and A+B.
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 800, grade: -5 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		const climb = climbs[0];
		expect(climb.lengthM).toBeGreaterThan(6500);
		expect(climb.parts).toHaveLength(2);
		const [a, b] = climb.parts!;
		// Parts nest inside the parent, stay ordered, and skip the dip.
		expect(a.startM).toBeGreaterThanOrEqual(climb.startM);
		expect(b.endM).toBeLessThanOrEqual(climb.endM);
		expect(a.endM).toBeLessThanOrEqual(b.startM);
		for (const part of [a, b]) {
			expect(part.lengthM).toBeGreaterThan(2500);
			expect(part.lengthM).toBeLessThan(3300);
			expect(part.avgGrade).toBeGreaterThan(6.4);
			expect(part.avgGrade).toBeLessThan(7.5);
			expect(part.parts).toBeUndefined();
		}
	});

	it('joins two real climbs across a 2 km descent', () => {
		// The headline tier-2 case: a genuine descent between two genuine
		// climbs resolves to one parent with two subclimbs.
		const route = legsRoute([
			{ lenM: 5000, grade: 7 },
			{ lenM: 2000, grade: -5 },
			{ lenM: 5000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].parts).toHaveLength(2);
		// Net stats span the descent: ~700 m up, ~100 m back down.
		expect(climbs[0].gainM).toBeGreaterThan(550);
		expect(climbs[0].gainM).toBeLessThan(650);
		expect(climbs[0].avgGrade).toBeGreaterThan(4.5);
		expect(climbs[0].avgGrade).toBeLessThan(5.5);
	});

	it('keeps climbs separated by a long net-flat section apart', () => {
		// 5 km of flat between two 3 km climbs dwarfs the gap budget —
		// these are two separate climbs, not one with parts.
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 5000, grade: 0 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(2);
		expect(climbs[0].parts).toBeUndefined();
		expect(climbs[1].parts).toBeUndefined();
	});

	it('drops an unjoinable runt instead of attaching it as a part', () => {
		// The 400 m tail after a real dip fails the floors (balanced: 500 m /
		// 40 m gain), so only the first climb survives — partless.
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 800, grade: -5 },
			{ lenM: 400, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].parts).toBeUndefined();
		expect(climbs[0].lengthM).toBeLessThan(3400);
	});

	it('keeps unbridged climbs part-free', () => {
		const route = legsRoute([
			{ lenM: 2000, grade: 0 },
			{ lenM: 5000, grade: 8 },
			{ lenM: 2000, grade: 0 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].parts).toBeUndefined();
	});

	it('splits climbs separated by a descent that exceeds the gap budget', () => {
		// 4 km of descent blows past maxJoinGapM (2.5 km on balanced).
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 4000, grade: -5 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(2);
		// Ordered and non-overlapping.
		expect(climbs[0].endM).toBeLessThanOrEqual(climbs[1].startM);
		expect(climbs[0].category).toBe('3');
		expect(climbs[1].category).toBe('3');
	});

	it('does not join across a descent that loses too much relative to the climbs', () => {
		// ~84 m lost between two 80 m climbs exceeds joinLossFrac (0.35 of
		// the combined ~160 m gain), even though the gap is short enough.
		const route = legsRoute([
			{ lenM: 1000, grade: 8 },
			{ lenM: 700, grade: -12 },
			{ lenM: 1000, grade: 8 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(2);
		expect(climbs[0].parts).toBeUndefined();
	});

	it('sensitive preset finds small climbs that balanced ignores', () => {
		const route = legsRoute([
			{ lenM: 1000, grade: 0 },
			{ lenM: 600, grade: 5 },
			{ lenM: 1000, grade: 0 }
		]);
		expect(detectClimbs(route, DETECTION_PRESETS.balanced)).toHaveLength(0);
		const climbs = detectClimbs(route, DETECTION_PRESETS.sensitive);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].category).toBeNull();
	});

	it('reports a max grade steeper than average on a stepped climb', () => {
		const route = legsRoute([
			{ lenM: 2000, grade: 4 },
			{ lenM: 2000, grade: 10 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].avgGrade).toBeGreaterThan(6.5);
		expect(climbs[0].avgGrade).toBeLessThan(7.5);
		expect(climbs[0].maxGrade).toBeGreaterThan(9.5);
		expect(climbs[0].maxGrade).toBeLessThan(10.5);
	});

	it('never categorizes a sub-3% grind, whatever its score', () => {
		const route = legsRoute([{ lenM: 12000, grade: 2.5 }]);
		const climbs = detectClimbs(route, DETECTION_PRESETS.sensitive);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].score).toBeGreaterThan(8000);
		expect(climbs[0].category).toBeNull();
	});
});

describe('climbCategory', () => {
	it('maps scores to the Strava-style bands', () => {
		expect(climbCategory(7999, 8)).toBeNull();
		expect(climbCategory(8000, 8)).toBe('4');
		expect(climbCategory(16000, 8)).toBe('3');
		expect(climbCategory(32000, 8)).toBe('2');
		expect(climbCategory(64000, 8)).toBe('1');
		expect(climbCategory(80000, 8)).toBe('HC');
	});

	it('requires at least 3% average grade', () => {
		expect(climbCategory(50000, 2.9)).toBeNull();
		expect(climbCategory(50000, 3)).toBe('2');
	});
});

describe('fietsIndex', () => {
	it('computes rise²/(length·10) below 1000 m', () => {
		expect(fietsIndex(400, 5000, 800)).toBeCloseTo(3.2, 10);
	});

	it('adds the altitude bonus above 1000 m', () => {
		// Alpe d'Huez ballpark.
		expect(fietsIndex(1000, 13000, 1850)).toBeCloseTo(8.54, 2);
	});

	it('is zero for degenerate lengths', () => {
		expect(fietsIndex(100, 0, 500)).toBe(0);
	});
});

describe('categoryColor', () => {
	it('gives every category a distinct color and falls back for null', () => {
		const colors = (['HC', '1', '2', '3', '4', null] as const).map(categoryColor);
		expect(new Set(colors).size).toBe(colors.length);
		for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
	});
});
