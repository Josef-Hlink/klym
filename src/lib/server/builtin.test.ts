import { describe, expect, it } from 'vitest';
import { STAGES, getBuiltinRoute, listBuiltinStages } from './builtin.js';

describe('builtin TdF 2026 stages', () => {
	it('has a consistent 21-stage table', () => {
		expect(STAGES.map((s) => s.stage)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
		const dates = STAGES.map((s) => s.date);
		expect(dates.every((d) => /^2026-07-\d{2}$/.test(d))).toBe(true);
		expect([...dates].sort()).toEqual(dates);
	});

	it('parses every bundled stage file', async () => {
		const stages = await listBuiltinStages();
		expect(stages.map((s) => s.stage)).toEqual(STAGES.map((s) => s.stage));
		for (const s of stages) {
			expect(s.id).toBe(`tdf-2026-stage-${s.stage}`);
			expect(s.pointCount).toBeGreaterThan(100);
			expect(s.totalDistM).toBeGreaterThan(10_000);
		}
		// Spot-check GPX distances against the route book (±10%).
		const km = (n: number) => stages.find((s) => s.stage === n)!.totalDistM / 1000;
		expect(km(1)).toBeCloseTo(19.6, -1); // Barcelona TTT
		expect(km(19)).toBeGreaterThan(115); // Gap → Alpe d'Huez, 127.9 km
		expect(km(19)).toBeLessThan(141);
	});

	it('shares one RouteData object across reads', async () => {
		const a = await getBuiltinRoute('tdf-2026-stage-19');
		const b = await getBuiltinRoute('tdf-2026-stage-19');
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(await getBuiltinRoute('nope')).toBeNull();
	});
});
