import { parseGpx } from '../gpx.js';
import type { RouteData, StageSummary } from '../types.js';

// Builtin example routes: the Tour de France 2026 stages, bundled into the
// server build and shared read-only by every visitor. GPX files come from
// cdn.cyclingstage.com (whitespace/trailing-zero slimmed, data untouched) and
// are parsed once per process on first access; the resulting RouteData
// objects are shared by reference across all sessions, so builtin routes cost
// nothing per visitor. Mutations never reach this module — storage.ts only
// falls back here for reads (and to materialize hidden per-session segment
// overlays, see writeSegment there).

const GPX_FILES = import.meta.glob('./tdf-2026/stage-*.gpx', {
	query: '?raw',
	import: 'default'
}) as Record<string, () => Promise<string>>;

export type StageInfo = {
	stage: number;
	/** Race day, YYYY-MM-DD (Europe/Paris). */
	date: string;
	start: string;
	finish: string;
};

export const STAGES: StageInfo[] = [
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
];

function stageId(stage: number): string {
	return `tdf-2026-stage-${stage}`;
}

let cache: Promise<Map<string, { info: StageInfo; route: RouteData }>> | null = null;

function loadAll(): Promise<Map<string, { info: StageInfo; route: RouteData }>> {
	cache ??= (async () => {
		const byId = new Map<string, { info: StageInfo; route: RouteData }>();
		for (const info of STAGES) {
			const load = GPX_FILES[`./tdf-2026/stage-${String(info.stage).padStart(2, '0')}.gpx`];
			if (!load) continue;
			try {
				const parsed = parseGpx(await load());
				const id = stageId(info.stage);
				byId.set(id, {
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
				console.error(`builtin: failed to parse stage ${info.stage} GPX`, err);
			}
		}
		return byId;
	})();
	return cache;
}

export async function getBuiltinRoute(id: string): Promise<RouteData | null> {
	return (await loadAll()).get(id)?.route ?? null;
}

export async function listBuiltinStages(): Promise<StageSummary[]> {
	const out: StageSummary[] = [];
	for (const { info, route } of (await loadAll()).values()) {
		const { points, bounds, ...rest } = route;
		out.push({ ...rest, pointCount: points.length, ...info });
	}
	out.sort((a, b) => a.stage - b.stage);
	return out;
}

/** Id of the stage being raced today (Europe/Paris), or null outside the Tour. */
export function todayStageId(): string | null {
	const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
	const info = STAGES.find((s) => s.date === today);
	return info ? stageId(info.stage) : null;
}
