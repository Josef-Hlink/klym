import { describe, expect, it } from 'vitest';
import { RACES, getBuiltinRoute, listBuiltinRaces } from './builtin.js';

describe('builtin grand tour stages', () => {
	it.each(RACES)('$id has a consistent 21-stage table', (race) => {
		expect(race.stages.map((s) => s.stage)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
		const dates = race.stages.map((s) => s.date);
		expect(dates.every((d) => /^2026-\d{2}-\d{2}$/.test(d))).toBe(true);
		expect([...dates].sort()).toEqual(dates);
	});

	it('parses every bundled stage file', async () => {
		const races = await listBuiltinRaces();
		expect(races.map((r) => r.id)).toEqual(RACES.map((r) => r.id));
		for (const race of races) {
			expect(race.stages.map((s) => s.stage)).toEqual(
				RACES.find((r) => r.id === race.id)!.stages.map((s) => s.stage)
			);
			for (const s of race.stages) {
				expect(s.id).toBe(`${race.id}-stage-${s.stage}`);
				expect(s.pointCount).toBeGreaterThan(100);
				expect(s.totalDistM).toBeGreaterThan(9_000);
			}
		}
	});

	it('matches the route books to within 10%', async () => {
		const races = await listBuiltinRaces();
		const km = (raceId: string, stage: number) =>
			races.find((r) => r.id === raceId)!.stages.find((s) => s.stage === stage)!.totalDistM / 1000;
		expect(km('tdf-2026', 1)).toBeCloseTo(19.6, -1); // Barcelona TTT
		expect(km('tdf-2026', 19)).toBeGreaterThan(115); // Gap → Alpe d'Huez, 127.9 km
		expect(km('tdf-2026', 19)).toBeLessThan(141);
		expect(km('vuelta-2026', 1)).toBeCloseTo(9.4, 0); // Monaco ITT
		expect(km('vuelta-2026', 19)).toBeGreaterThan(185); // Vélez-Málaga → Peñas Blancas, 205 km
		expect(km('vuelta-2026', 19)).toBeLessThan(226);
	});

	it('shares one RouteData object across reads', async () => {
		const a = await getBuiltinRoute('vuelta-2026-stage-19');
		const b = await getBuiltinRoute('vuelta-2026-stage-19');
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(await getBuiltinRoute('tdf-2026-stage-19')).not.toBeNull();
		expect(await getBuiltinRoute('nope')).toBeNull();
	});
});
