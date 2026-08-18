import { parseGpx } from '../gpx.js';
import type { BuiltinRace, RouteData, StageSummary } from '../types.js';

// Builtin example routes: the 2026 grand tour stages, bundled into the server
// build and shared read-only by every visitor. GPX files come from
// cdn.cyclingstage.com (whitespace/trailing-zero slimmed, data untouched) and
// are parsed once per process on first access; the resulting RouteData
// objects are shared by reference across all sessions, so builtin routes cost
// nothing per visitor. Mutations never reach this module — storage.ts only
// falls back here for reads (and to materialize hidden per-session segment
// overlays, see writeSegment there).
//
// Adding a race is a data-only change: drop slimmed stage-NN.gpx files in a
// new sibling directory and add a RACES entry pointing at it.

const GPX_FILES = import.meta.glob('./*/stage-*.gpx', {
	query: '?raw',
	import: 'default'
}) as Record<string, () => Promise<string>>;

export type StageInfo = {
	stage: number;
	/** Race day, YYYY-MM-DD in the race's own time zone. */
	date: string;
	start: string;
	finish: string;
};

export type RaceInfo = {
	/** Id prefix — stage ids are `${id}-stage-${n}`. */
	id: string;
	label: string;
	flag: string;
	/** Directory holding the bundled stage-NN.gpx files. */
	dir: string;
	/** Time zone the race is run in, for the "today" badge. */
	timeZone: string;
	/** Whether the homepage expands this race's list on load. */
	defaultOpen: boolean;
	stages: StageInfo[];
};

export const RACES: RaceInfo[] = [
	{
		id: 'vuelta-2026',
		label: 'Vuelta',
		flag: '🇪🇸',
		dir: './vuelta-2026',
		timeZone: 'Europe/Madrid',
		defaultOpen: true,
		stages: [
			{ stage: 1, date: '2026-08-22', start: 'Monaco', finish: 'Monaco' },
			{ stage: 2, date: '2026-08-23', start: 'Monaco', finish: 'Manosque' },
			{ stage: 3, date: '2026-08-24', start: 'Gruissan', finish: 'Font-Romeu' },
			{ stage: 4, date: '2026-08-25', start: 'Andorra la Vella', finish: 'Andorra la Vella' },
			{ stage: 5, date: '2026-08-26', start: 'Falset', finish: 'Roquetes' },
			{ stage: 6, date: '2026-08-27', start: 'Alcossebre', finish: 'Castellón' },
			{ stage: 7, date: '2026-08-28', start: "Vall d'Alba", finish: 'Valdelinares' },
			{ stage: 8, date: '2026-08-29', start: 'Puçol', finish: 'Xeraco' },
			{ stage: 9, date: '2026-08-30', start: 'La Vila Joiosa', finish: 'Alto de Aitana' },
			{ stage: 10, date: '2026-09-01', start: 'Alcaraz', finish: 'Elche de la Sierra' },
			{ stage: 11, date: '2026-09-02', start: 'Cartagena', finish: 'Lorca' },
			{ stage: 12, date: '2026-09-03', start: 'Vera', finish: 'Calar Alto' },
			{ stage: 13, date: '2026-09-04', start: 'Almuñécar', finish: 'Loja' },
			{ stage: 14, date: '2026-09-05', start: 'Jaén', finish: 'Sierra de la Pandera' },
			{ stage: 15, date: '2026-09-06', start: 'Palma del Río', finish: 'Córdoba' },
			{ stage: 16, date: '2026-09-08', start: 'Cortegana', finish: 'La Rábida' },
			{ stage: 17, date: '2026-09-09', start: 'Dos Hermanas', finish: 'Sevilla' },
			{ stage: 18, date: '2026-09-10', start: 'El Puerto de Santa María', finish: 'Jerez de la Frontera' },
			{ stage: 19, date: '2026-09-11', start: 'Vélez-Málaga', finish: 'Peñas Blancas' },
			{ stage: 20, date: '2026-09-12', start: 'La Calahorra', finish: 'Collado del Alguacil' },
			{ stage: 21, date: '2026-09-13', start: 'Granada', finish: 'Granada' }
		]
	},
	{
		id: 'tdf-2026',
		label: 'Tour',
		flag: '🇫🇷',
		dir: './tdf-2026',
		timeZone: 'Europe/Paris',
		defaultOpen: false,
		stages: [
			{ stage: 1, date: '2026-07-04', start: 'Barcelona', finish: 'Barcelona' },
			{ stage: 2, date: '2026-07-05', start: 'Tarragona', finish: 'Barcelona' },
			{ stage: 3, date: '2026-07-06', start: 'Granollers', finish: 'Les Angles' },
			{ stage: 4, date: '2026-07-07', start: 'Carcassonne', finish: 'Foix' },
			{ stage: 5, date: '2026-07-08', start: 'Lannemezan', finish: 'Pau' },
			{ stage: 6, date: '2026-07-09', start: 'Pau', finish: 'Gavarnie-Gèdre' },
			{ stage: 7, date: '2026-07-10', start: 'Hagetmau', finish: 'Bordeaux' },
			{ stage: 8, date: '2026-07-11', start: 'Périgueux', finish: 'Bergerac' },
			{ stage: 9, date: '2026-07-12', start: 'Malemort', finish: 'Ussel' },
			{ stage: 10, date: '2026-07-14', start: 'Aurillac', finish: 'Le Lioran' },
			{ stage: 11, date: '2026-07-15', start: 'Vichy', finish: 'Nevers' },
			{ stage: 12, date: '2026-07-16', start: 'Magny-Cours', finish: 'Chalon-sur-Saône' },
			{ stage: 13, date: '2026-07-17', start: 'Dole', finish: 'Belfort' },
			{ stage: 14, date: '2026-07-18', start: 'Mulhouse', finish: 'Le Markstein' },
			{ stage: 15, date: '2026-07-19', start: 'Champagnole', finish: 'Plateau de Solaison' },
			{ stage: 16, date: '2026-07-21', start: 'Évian-les-Bains', finish: 'Thonon-les-Bains' },
			{ stage: 17, date: '2026-07-22', start: 'Chambéry', finish: 'Voiron' },
			{ stage: 18, date: '2026-07-23', start: 'Voiron', finish: 'Orcières-Merlette' },
			{ stage: 19, date: '2026-07-24', start: 'Gap', finish: "Alpe d'Huez" },
			{ stage: 20, date: '2026-07-25', start: "Le Bourg-d'Oisans", finish: "Alpe d'Huez" },
			{ stage: 21, date: '2026-07-26', start: 'Thoiry', finish: 'Paris' }
		]
	}
];

function stageId(race: RaceInfo, stage: number): string {
	return `${race.id}-stage-${stage}`;
}

type Entry = { race: RaceInfo; info: StageInfo; route: RouteData };

let cache: Promise<Map<string, Entry>> | null = null;

function loadAll(): Promise<Map<string, Entry>> {
	cache ??= (async () => {
		const byId = new Map<string, Entry>();
		for (const race of RACES) {
			for (const info of race.stages) {
				const load = GPX_FILES[`${race.dir}/stage-${String(info.stage).padStart(2, '0')}.gpx`];
				if (!load) continue;
				try {
					const parsed = parseGpx(await load());
					const id = stageId(race, info.stage);
					byId.set(id, {
						race,
						info,
						route: {
							id,
							name: `Stage ${info.stage} · ${info.start} → ${info.finish}`,
							points: parsed.points,
							totalDistM: parsed.totalDistM,
							totalAscentM: parsed.totalAscentM,
							bounds: parsed.bounds,
							createdAt: `${info.date}T00:00:00.000Z`
						}
					});
				} catch (err) {
					// A bad bundled file shouldn't take the homepage down with it.
					console.error(`builtin: failed to parse ${race.id} stage ${info.stage} GPX`, err);
				}
			}
		}
		return byId;
	})();
	return cache;
}

export async function getBuiltinRoute(id: string): Promise<RouteData | null> {
	return (await loadAll()).get(id)?.route ?? null;
}

/** Every builtin race with its parsed stages, in RACES order. */
export async function listBuiltinRaces(): Promise<BuiltinRace[]> {
	const stagesByRace = new Map<string, StageSummary[]>(RACES.map((r) => [r.id, []]));
	for (const { race, info, route } of (await loadAll()).values()) {
		const { points, bounds, ...rest } = route;
		stagesByRace.get(race.id)?.push({ ...rest, pointCount: points.length, ...info });
	}
	return RACES.map(({ id, label, flag, defaultOpen }) => ({
		id,
		label,
		flag,
		defaultOpen,
		stages: (stagesByRace.get(id) ?? []).sort((a, b) => a.stage - b.stage)
	}));
}

/** Id of the stage being raced today, or null when no race is on. */
export function todayStageId(): string | null {
	for (const race of RACES) {
		const today = new Date().toLocaleDateString('en-CA', { timeZone: race.timeZone });
		const info = race.stages.find((s) => s.date === today);
		if (info) return stageId(race, info.stage);
	}
	return null;
}
