import type { RoutePoint } from './types.js';

export type InterpolatedPoint = {
	lat: number;
	lon: number;
	ele: number;
	cumDistM: number;
	idx: number;
};

export function findPointAtDistance(
	points: RoutePoint[],
	distM: number
): InterpolatedPoint {
	if (points.length === 0) {
		return { lat: 0, lon: 0, ele: 0, cumDistM: 0, idx: 0 };
	}
	const target = Math.max(0, Math.min(distM, points[points.length - 1].cumDistM));

	let lo = 0;
	let hi = points.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (points[mid].cumDistM < target) lo = mid + 1;
		else hi = mid;
	}
	const b = points[lo];
	if (lo === 0) return { lat: b.lat, lon: b.lon, ele: b.ele, cumDistM: b.cumDistM, idx: 0 };
	const a = points[lo - 1];
	const span = b.cumDistM - a.cumDistM;
	const t = span > 0 ? (target - a.cumDistM) / span : 0;
	return {
		lat: a.lat + (b.lat - a.lat) * t,
		lon: a.lon + (b.lon - a.lon) * t,
		ele: a.ele + (b.ele - a.ele) * t,
		cumDistM: target,
		idx: lo
	};
}

export function gradeAtDistance(
	points: RoutePoint[],
	distM: number,
	windowM = 100
): number {
	if (points.length < 2) return 0;
	const total = points[points.length - 1].cumDistM;
	const lo = Math.max(0, distM - windowM / 2);
	const hi = Math.min(total, distM + windowM / 2);
	const pLo = findPointAtDistance(points, lo);
	const pHi = findPointAtDistance(points, hi);
	const run = pHi.cumDistM - pLo.cumDistM;
	if (run <= 0) return 0;
	return ((pHi.ele - pLo.ele) / run) * 100;
}

export type GradeBucket = {
	grade: number;
	startM: number;
	endM: number;
};

export function bucketGradeAtDistance(
	points: RoutePoint[],
	distM: number,
	binSizeM = 500
): GradeBucket {
	if (points.length < 2) return { grade: 0, startM: 0, endM: 0 };
	const total = points[points.length - 1].cumDistM;
	const clamped = Math.max(0, Math.min(distM, total));
	const startM = Math.floor(clamped / binSizeM) * binSizeM;
	const endM = Math.min(total, startM + binSizeM);
	const a = findPointAtDistance(points, startM);
	const b = findPointAtDistance(points, endM);
	const run = b.cumDistM - a.cumDistM;
	const grade = run > 0 ? ((b.ele - a.ele) / run) * 100 : 0;
	return { grade, startM, endM };
}

export function gradeColor(grade: number): string {
	if (grade < -1) return '#64748b';
	if (grade < 1) return '#eab308';
	if (grade < 3) return '#f59e0b';
	if (grade < 5) return '#f97316';
	if (grade < 7) return '#ea580c';
	if (grade < 9) return '#dc2626';
	if (grade < 12) return '#b91c1c';
	return '#7f1d1d';
}
