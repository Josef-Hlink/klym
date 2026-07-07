import { describe, expect, it } from 'vitest';
import {
	CATEGORY_CODE,
	GARMIN_MAX_CLIMBS,
	GARMIN_MAX_POINTS,
	GARMIN_NAME_MAX,
	buildGarminPayload,
	sanitizeGarminClimbs,
	toGarminClimbInputs
} from './garmin.js';
import { detectClimbs } from './climbs.js';
import { getBuiltinRoute } from './server/builtin.js';
import type { DetectedClimb } from './climbs.js';
import type { RouteData, RoutePoint } from './types.js';

// Straight synthetic route: constant grade, sampled every stepM, heading due
// north from (45, 5). Only ele/cumDistM/lat need to be meaningful.
function line(lengthM: number, grade: number, stepM = 20): RouteData {
	const points: RoutePoint[] = [];
	for (let d = 0; d <= lengthM; d += stepM) {
		points.push({
			lat: 45 + d / 111_320,
			lon: 5,
			ele: 100 + (d * grade) / 100,
			cumDistM: d
		});
	}
	const last = points[points.length - 1];
	if (last.cumDistM < lengthM) {
		points.push({
			lat: 45 + lengthM / 111_320,
			lon: 5,
			ele: 100 + (lengthM * grade) / 100,
			cumDistM: lengthM
		});
	}
	return {
		id: 'test',
		name: 'Test route',
		points,
		totalDistM: lengthM,
		totalAscentM: Math.max(0, (lengthM * grade) / 100),
		bounds: { minLat: 45, maxLat: 46, minLon: 5, maxLon: 5, minEle: 0, maxEle: 3000 },
		createdAt: '2026-07-01T00:00:00.000Z'
	};
}

const climb = (over: Partial<DetectedClimb> = {}): DetectedClimb => ({
	startM: 2000,
	endM: 7000,
	lengthM: 5000,
	gainM: 400,
	avgGrade: 8,
	maxGrade: 10,
	startEleM: 100,
	topEleM: 500,
	score: 40_000,
	fiets: 3,
	category: '2',
	...over
});

describe('buildGarminPayload', () => {
	it('picks the step from the distance and floors it at 50 m', () => {
		expect(buildGarminPayload(line(10_000, 0), []).step).toBe(50);
		// 181 km / 1200 = 150.83 → next 10 m step up = 160.
		expect(buildGarminPayload(line(181_000, 0), []).step).toBe(160);
	});

	it('keeps the sample count within budget and pins the last sample to the end', () => {
		const p = buildGarminPayload(line(181_000, 1), []);
		const n = p.e.length;
		expect(n).toBeLessThanOrEqual(GARMIN_MAX_POINTS + 1);
		expect(p.lat.length).toBe(n);
		expect(p.lon.length).toBe(n);
		// Last sample is the route end, not the last full step.
		expect(p.e[n - 1]).toBe(Math.round((100 + 1810) * 10));
	});

	it('aligns index ↔ distance ↔ elevation on the shared step', () => {
		const p = buildGarminPayload(line(10_000, 5), []);
		expect(p.step).toBe(50);
		// e[i] = (100 + i·step·5%) m in decimeters.
		expect(p.e[0]).toBe(1000);
		expect(p.e[10]).toBe(Math.round((100 + (10 * 50 * 5) / 100) * 10));
	});

	it('scales lat/lon to 1e5 ints', () => {
		const p = buildGarminPayload(line(1000, 0), []);
		expect(p.lon.every((v) => v === 500_000)).toBe(true);
		expect(p.lat[0]).toBe(4_500_000);
		expect(p.lat[p.lat.length - 1]).toBe(Math.round((45 + 1000 / 111_320) * 1e5));
	});

	it('encodes climbs as sorted tuples with cat codes and ×10 grades', () => {
		const p = buildGarminPayload(line(20_000, 0), [
			{ startM: 9000.4, endM: 12_000.6, avgGrade: 6.24, gainM: 187.3, maxGrade: 9.96, category: null },
			{ startM: 2000, endM: 7000, avgGrade: 8.04, gainM: 402, maxGrade: 11.2, category: 'HC' }
		]);
		expect(p.c).toEqual([
			[2000, 7000, 5, 80, 402, 112],
			[9000, 12_001, 0, 62, 187, 100]
		]);
	});

	it('truncates the name and stamps ts from opts.now', () => {
		const route = { ...line(1000, 0), name: 'A very long route name indeed, yes' };
		const p = buildGarminPayload(route, [], { now: new Date('2026-07-05T12:00:00Z') });
		expect(p.name).toHaveLength(GARMIN_NAME_MAX);
		expect(p.ts).toBe(Date.UTC(2026, 6, 5, 12) / 1000);
		expect(p.v).toBe(1);
		expect(p.dist).toBe(1000);
	});
});

describe('toGarminClimbInputs', () => {
	it('keeps only the wire fields and drops parts', () => {
		const inputs = toGarminClimbInputs([climb({ parts: [climb(), climb()] })]);
		expect(inputs).toEqual([
			{ startM: 2000, endM: 7000, avgGrade: 8, gainM: 400, maxGrade: 10, category: '2' }
		]);
	});
});

describe('sanitizeGarminClimbs', () => {
	const valid = { startM: 100, endM: 900, avgGrade: 5, gainM: 40, maxGrade: 7, category: null };

	it('rejects non-arrays and junk entries', () => {
		expect(sanitizeGarminClimbs('nope', 1000)).toEqual([]);
		expect(sanitizeGarminClimbs({ startM: 1 }, 1000)).toEqual([]);
		expect(
			sanitizeGarminClimbs(
				[
					null,
					42,
					{ ...valid, startM: 'zero' }, // wrong type
					{ ...valid, gainM: NaN }, // non-finite
					{ ...valid, startM: 900, endM: 100 }, // inverted
					{ ...valid, startM: -5 }, // negative
					{ ...valid, startM: 1500 }, // beyond the route
					{ ...valid, category: 'X' } // unknown category
				],
				1000
			)
		).toEqual([]);
	});

	it('keeps valid entries, clamps endM, sorts, and caps the count', () => {
		const many = Array.from({ length: 60 }, (_, i) => ({
			...valid,
			startM: (59 - i) * 10,
			endM: (59 - i) * 10 + 5
		}));
		const out = sanitizeGarminClimbs([...many, { ...valid, startM: 990, endM: 4000 }], 1000);
		expect(out).toHaveLength(GARMIN_MAX_CLIMBS);
		expect(out[0].startM).toBe(0);
		expect(out.every((c, i) => i === 0 || c.startM >= out[i - 1].startM)).toBe(true);
		expect(sanitizeGarminClimbs([{ ...valid, endM: 4000 }], 1000)[0].endM).toBe(1000);
	});

	it('accepts every real category code', () => {
		for (const cat of Object.keys(CATEGORY_CODE)) {
			const out = sanitizeGarminClimbs([{ ...valid, category: cat }], 1000);
			expect(out[0].category).toBe(cat);
		}
	});
});

describe('payload size on a real stage', () => {
	it('stays within the Edge 540 budget for stage 19 (Gap → Alpe d\'Huez)', async () => {
		const route = await getBuiltinRoute('tdf-2026-stage-19');
		expect(route).not.toBeNull();
		const climbs = toGarminClimbInputs(detectClimbs(route!.points));
		const payload = buildGarminPayload(route!, climbs, {
			now: new Date('2026-07-05T00:00:00Z')
		});
		expect(payload.e.length).toBeLessThanOrEqual(GARMIN_MAX_POINTS + 1);
		expect(payload.c.length).toBeGreaterThan(0);
		expect(payload.c.length).toBeLessThanOrEqual(GARMIN_MAX_CLIMBS);
		for (const [startM, endM] of payload.c) {
			expect(startM).toBeGreaterThanOrEqual(0);
			expect(endM).toBeLessThanOrEqual(payload.dist);
		}
		// The whole point: the JSON must fit comfortably through the phone
		// relay and inside the device's memory budget.
		expect(JSON.stringify(payload).length).toBeLessThan(32_000);
	});
});
