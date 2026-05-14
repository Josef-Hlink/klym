import { describe, it, expect } from 'vitest';
import {
	bucketGradeAtDistance,
	computeAdaptiveBins,
	computeBins,
	computeCropStats,
	findPointAtDistance,
	gradeAtDistance,
	gradeColor
} from './elevation.js';
import type { RoutePoint } from './types.js';

// Synthetic route: 0..1000m at 10m/m gradient (so ele = dist * 0.01).
// Each point spaced 100m, total 11 points.
const linearRoute: RoutePoint[] = Array.from({ length: 11 }, (_, i) => ({
	lat: 45 + i * 0.001,
	lon: 5 + i * 0.001,
	ele: i * 1, // 0, 1, 2, ..., 10
	cumDistM: i * 100
}));

describe('findPointAtDistance', () => {
	it('returns a zero stub for empty input', () => {
		const p = findPointAtDistance([], 500);
		expect(p).toEqual({ lat: 0, lon: 0, ele: 0, cumDistM: 0, idx: 0 });
	});

	it('clamps below zero to the first point', () => {
		const p = findPointAtDistance(linearRoute, -100);
		expect(p.cumDistM).toBe(0);
		expect(p.ele).toBe(0);
	});

	it('clamps past the end to the last point', () => {
		const p = findPointAtDistance(linearRoute, 99999);
		expect(p.cumDistM).toBe(1000);
		expect(p.ele).toBe(10);
	});

	it('hits exact vertices without interpolation drift', () => {
		const p = findPointAtDistance(linearRoute, 500);
		expect(p.cumDistM).toBe(500);
		expect(p.ele).toBeCloseTo(5, 10);
	});

	it('interpolates linearly between vertices', () => {
		const p = findPointAtDistance(linearRoute, 250);
		expect(p.cumDistM).toBe(250);
		expect(p.ele).toBeCloseTo(2.5, 10);
		expect(p.lat).toBeCloseTo(45 + 2.5 * 0.001, 10);
	});

	it('lerps activity streams when both neighbors have them', () => {
		const route: RoutePoint[] = [
			{ lat: 0, lon: 0, ele: 0, cumDistM: 0, hr: 100, power: 200, cad: 80, spd: 5 },
			{ lat: 0, lon: 0, ele: 10, cumDistM: 100, hr: 140, power: 240, cad: 90, spd: 7 }
		];
		const p = findPointAtDistance(route, 50);
		expect(p.hr).toBeCloseTo(120, 10);
		expect(p.power).toBeCloseTo(220, 10);
		expect(p.cad).toBeCloseTo(85, 10);
		expect(p.spd).toBeCloseTo(6, 10);
	});

	it('omits streams when either neighbor lacks them', () => {
		const route: RoutePoint[] = [
			{ lat: 0, lon: 0, ele: 0, cumDistM: 0, hr: 100 },
			{ lat: 0, lon: 0, ele: 10, cumDistM: 100 }
		];
		const p = findPointAtDistance(route, 50);
		expect(p.hr).toBeUndefined();
		expect(p.power).toBeUndefined();
	});
});

describe('gradeAtDistance', () => {
	it('returns 0 when there are fewer than two points', () => {
		expect(gradeAtDistance([], 100)).toBe(0);
		expect(gradeAtDistance([linearRoute[0]], 100)).toBe(0);
	});

	it('reports the underlying constant gradient', () => {
		// linearRoute climbs 1m per 100m of distance => 1.0%
		expect(gradeAtDistance(linearRoute, 500, 200)).toBeCloseTo(1, 6);
	});

	it('does not divide by zero when the window collapses past the end', () => {
		// Window centred well past the end clamps to a single point.
		expect(gradeAtDistance(linearRoute, 99999, 100)).toBe(0);
	});
});

describe('bucketGradeAtDistance', () => {
	it('snaps the bucket to binSize boundaries', () => {
		const b = bucketGradeAtDistance(linearRoute, 320, 200);
		expect(b.startM).toBe(200);
		expect(b.endM).toBe(400);
		expect(b.grade).toBeCloseTo(1, 6);
	});

	it('caps the final bucket at the route end', () => {
		const b = bucketGradeAtDistance(linearRoute, 950, 200);
		expect(b.startM).toBe(800);
		expect(b.endM).toBe(1000);
	});
});

describe('computeBins', () => {
	it('produces uniformly-sized bins across an exact range', () => {
		const bins = computeBins(linearRoute, 0, 1000, 250);
		expect(bins).toHaveLength(4);
		expect(bins[0]).toMatchObject({ startM: 0, endM: 250 });
		expect(bins[3]).toMatchObject({ startM: 750, endM: 1000 });
		for (const b of bins) expect(b.grade).toBeCloseTo(1, 6);
	});

	it('clips a partial trailing bin to endM', () => {
		const bins = computeBins(linearRoute, 0, 600, 250);
		expect(bins.at(-1)?.endM).toBe(600);
	});

	it('returns an empty array when the range is degenerate', () => {
		expect(computeBins(linearRoute, 500, 500, 250)).toEqual([]);
	});
});

describe('computeCropStats', () => {
	it('on a constant-gradient route, avg == max and ascent == netGain', () => {
		const s = computeCropStats(linearRoute, 0, 1000, 250);
		expect(s.lengthM).toBe(1000);
		expect(s.netGainM).toBeCloseTo(10, 6);
		expect(s.avgGrade).toBeCloseTo(1, 6);
		expect(s.maxGrade).toBeCloseTo(1, 6);
		expect(s.totalAscentM).toBeCloseTo(s.netGainM, 1);
	});

	it('counts only positive smoothed deltas (descents do not cancel ascents)', () => {
		// Up 50m over 500m, then back down 50m over 500m — net 0, but ~50m climbed.
		const tent: RoutePoint[] = Array.from({ length: 21 }, (_, i) => ({
			lat: 45,
			lon: 5,
			ele: i <= 10 ? i * 5 : (20 - i) * 5,
			cumDistM: i * 50
		}));
		const s = computeCropStats(tent, 0, 1000, 250);
		expect(s.netGainM).toBeCloseTo(0, 6);
		expect(s.totalAscentM).toBeGreaterThan(45);
		expect(s.totalAscentM).toBeLessThan(55);
	});

	it('the 50m smoothing kills high-frequency noise that would otherwise ~triple the ascent', () => {
		// True profile: climbs 100m linearly over 1000m, point every 10m (101 points).
		// Add ±3m alternating noise — naive positive-delta sum hugely over-reports.
		const noisy: RoutePoint[] = Array.from({ length: 101 }, (_, i) => ({
			lat: 45,
			lon: 5,
			ele: i + (i % 2 === 0 ? 3 : -3),
			cumDistM: i * 10
		}));
		// Sanity check: naive sum would be roughly 350m (~3.5x) for this noise pattern.
		let naive = 0;
		for (let i = 1; i < noisy.length; i++) {
			const d = noisy[i].ele - noisy[i - 1].ele;
			if (d > 0) naive += d;
		}
		expect(naive).toBeGreaterThan(300);

		const s = computeCropStats(noisy, 0, 1000);
		// Smoothed result should be in the ballpark of the true 100m, not the naive ~350.
		expect(s.totalAscentM).toBeGreaterThan(80);
		expect(s.totalAscentM).toBeLessThan(150);
	});

	it('finds the steepest bin in a route with a single steep section', () => {
		// 0..400m flat, 400..600m climbs 100m (50% — silly but obvious), 600..1000m flat.
		const stepped: RoutePoint[] = [];
		for (let d = 0; d <= 1000; d += 50) {
			let ele = 0;
			if (d <= 400) ele = 0;
			else if (d <= 600) ele = ((d - 400) / 200) * 100;
			else ele = 100;
			stepped.push({ lat: 45, lon: 5, ele, cumDistM: d });
		}
		const s = computeCropStats(stepped, 0, 1000, 200);
		expect(s.maxGradeBucket).not.toBeNull();
		expect(s.maxGradeBucket!.startM).toBe(400);
		expect(s.maxGradeBucket!.endM).toBe(600);
		expect(s.maxGrade).toBeCloseTo(50, 4);
	});

	it('handles a degenerate (zero-length) range without NaN', () => {
		const s = computeCropStats(linearRoute, 500, 500, 250);
		expect(s.lengthM).toBe(0);
		expect(s.netGainM).toBe(0);
		expect(s.totalAscentM).toBe(0);
		expect(s.avgGrade).toBe(0);
		expect(s.maxGradeBucket).toBeNull();
		expect(Number.isFinite(s.maxGrade)).toBe(true);
	});
});

describe('computeAdaptiveBins', () => {
	it('returns no bins when input is empty or the range is degenerate', () => {
		expect(computeAdaptiveBins([], 0, 1000, 1)).toEqual([]);
		expect(computeAdaptiveBins(linearRoute, 500, 500, 1)).toEqual([]);
		expect(computeAdaptiveBins(linearRoute, 800, 100, 1)).toEqual([]);
	});

	it('collapses a perfectly linear profile to a single bin', () => {
		const bins = computeAdaptiveBins(linearRoute, 0, 1000, 0.5);
		expect(bins).toHaveLength(1);
		expect(bins[0].startM).toBe(0);
		expect(bins[0].endM).toBe(1000);
		expect(bins[0].grade).toBeCloseTo(1, 6);
	});

	it('breaks at a sharp elevation kink', () => {
		// V-shape: ele = |i - 10| over 21 points, 50m apart.
		const kinked: RoutePoint[] = Array.from({ length: 21 }, (_, i) => ({
			lat: 45,
			lon: 5,
			ele: Math.abs(i - 10) * 5,
			cumDistM: i * 50
		}));
		const bins = computeAdaptiveBins(kinked, 0, 1000, 1);
		// Two bins: down then up. Boundary should sit near the bottom of the V (500m).
		expect(bins).toHaveLength(2);
		expect(bins[0].grade).toBeLessThan(0);
		expect(bins[1].grade).toBeGreaterThan(0);
		expect(bins[0].endM).toBeCloseTo(500, 1);
		expect(bins[1].startM).toBeCloseTo(500, 1);
	});

	it('produces fewer bins as epsilon increases', () => {
		// Sawtooth — three peaks of decreasing amplitude.
		const sawtooth: RoutePoint[] = Array.from({ length: 31 }, (_, i) => ({
			lat: 45,
			lon: 5,
			ele: Math.sin((i / 30) * Math.PI * 6) * (10 - i * 0.2),
			cumDistM: i * 50
		}));
		const tight = computeAdaptiveBins(sawtooth, 0, 1500, 0.5);
		const loose = computeAdaptiveBins(sawtooth, 0, 1500, 8);
		expect(tight.length).toBeGreaterThan(loose.length);
	});
});

describe('gradeColor', () => {
	// Cutoffs sit at half-integers so a grade rounding to N falls in the
	// bucket whose label is N%. Test the boundaries directly.
	it('descent (< -0.5) is slate', () => {
		expect(gradeColor(-0.51)).toBe('#64748b');
		expect(gradeColor(-100)).toBe('#64748b');
	});

	it('flat band [-0.5, 0.5) is yellow', () => {
		expect(gradeColor(-0.5)).toBe('#eab308');
		expect(gradeColor(0)).toBe('#eab308');
		expect(gradeColor(0.49)).toBe('#eab308');
	});

	it('crosses up through the warm ramp at half-integer steps', () => {
		expect(gradeColor(0.5)).toBe('#f59e0b'); // amber (1-2%)
		expect(gradeColor(2.5)).toBe('#f97316'); // orange (3-4%)
		expect(gradeColor(4.5)).toBe('#ea580c'); // dark orange (5-6%)
		expect(gradeColor(6.5)).toBe('#dc2626'); // red (7-8%)
		expect(gradeColor(8.5)).toBe('#b91c1c'); // deep red (9-11%)
		expect(gradeColor(11.5)).toBe('#7f1d1d'); // 12%+
	});

	it('a grade rounding to -1% lands in slate (the regression the cutoff comment warns about)', () => {
		expect(gradeColor(-0.95)).toBe('#64748b');
	});
});
