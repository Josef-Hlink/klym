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

	it('bridges a short dip inside a long climb', () => {
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 200, grade: -1 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].lengthM).toBeGreaterThan(5900);
	});

	it('exposes both halves of a bridged climb as parts', () => {
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 200, grade: -1 },
			{ lenM: 3000, grade: 7 }
		]);
		const [climb] = detectClimbs(route);
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

	it('omits parts when only one constituent clears the filters', () => {
		// The 400 m tail after the dip is too short/small to stand alone
		// (balanced floors: 500 m / 40 m gain), so no parts are attached.
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 150, grade: -1 },
			{ lenM: 400, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(1);
		expect(climbs[0].parts).toBeUndefined();
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

	it('splits climbs separated by a long descent', () => {
		const route = legsRoute([
			{ lenM: 3000, grade: 7 },
			{ lenM: 2000, grade: -5 },
			{ lenM: 3000, grade: 7 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(2);
		// Ordered and non-overlapping.
		expect(climbs[0].endM).toBeLessThanOrEqual(climbs[1].startM);
		expect(climbs[0].category).toBe('3');
		expect(climbs[1].category).toBe('3');
	});

	it('does not bridge a gap that loses too much elevation', () => {
		// 24 m lost in 300 m exceeds balanced's 15 m gap-loss budget.
		const route = legsRoute([
			{ lenM: 1000, grade: 8 },
			{ lenM: 300, grade: -8 },
			{ lenM: 1000, grade: 8 }
		]);
		const climbs = detectClimbs(route);
		expect(climbs).toHaveLength(2);
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
