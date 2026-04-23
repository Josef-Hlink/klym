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

export type CropStats = {
	lengthM: number;
	netGainM: number;
	totalAscentM: number;
	avgGrade: number;
	maxGrade: number;
	maxGradeBucket: { startM: number; endM: number } | null;
};

const ASCENT_SMOOTH_WINDOW_M = 50;

function computeTotalAscent(
	points: RoutePoint[],
	startM: number,
	endM: number,
	windowM: number
): number {
	const idxs: number[] = [];
	for (let i = 0; i < points.length; i++) {
		const d = points[i].cumDistM;
		if (d < startM) continue;
		if (d > endM) break;
		idxs.push(i);
	}
	if (idxs.length < 2) return 0;

	const halfW = windowM / 2;
	const smoothed: number[] = new Array(idxs.length);
	for (let k = 0; k < idxs.length; k++) {
		const i = idxs[k];
		const center = points[i].cumDistM;
		let sum = points[i].ele;
		let count = 1;
		for (let j = i - 1; j >= 0 && center - points[j].cumDistM <= halfW; j--) {
			sum += points[j].ele;
			count++;
		}
		for (let j = i + 1; j < points.length && points[j].cumDistM - center <= halfW; j++) {
			sum += points[j].ele;
			count++;
		}
		smoothed[k] = sum / count;
	}

	let ascent = 0;
	for (let k = 1; k < smoothed.length; k++) {
		const d = smoothed[k] - smoothed[k - 1];
		if (d > 0) ascent += d;
	}
	return ascent;
}

export function computeCropStats(
	points: RoutePoint[],
	startM: number,
	endM: number,
	binSizeM = 500
): CropStats {
	const a = findPointAtDistance(points, startM);
	const b = findPointAtDistance(points, endM);
	const lengthM = b.cumDistM - a.cumDistM;
	const netGainM = b.ele - a.ele;
	const avgGrade = lengthM > 0 ? (netGainM / lengthM) * 100 : 0;
	const totalAscentM = computeTotalAscent(
		points,
		a.cumDistM,
		b.cumDistM,
		ASCENT_SMOOTH_WINDOW_M
	);

	let maxGrade = -Infinity;
	let maxGradeBucket: { startM: number; endM: number } | null = null;
	for (let d = a.cumDistM; d < b.cumDistM; d += binSizeM) {
		const binEnd = Math.min(b.cumDistM, d + binSizeM);
		const p0 = findPointAtDistance(points, d);
		const p1 = findPointAtDistance(points, binEnd);
		const run = p1.cumDistM - p0.cumDistM;
		if (run <= 0) continue;
		const grade = ((p1.ele - p0.ele) / run) * 100;
		if (grade > maxGrade) {
			maxGrade = grade;
			maxGradeBucket = { startM: p0.cumDistM, endM: p1.cumDistM };
		}
	}
	if (maxGrade === -Infinity) maxGrade = avgGrade;

	return { lengthM, netGainM, totalAscentM, avgGrade, maxGrade, maxGradeBucket };
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
