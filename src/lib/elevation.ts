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

export type GradeBin = {
	startM: number;
	endM: number;
	startEle: number;
	endEle: number;
	grade: number;
};

export function computeBins(
	points: RoutePoint[],
	startM: number,
	endM: number,
	binSizeM = 500
): GradeBin[] {
	const bins: GradeBin[] = [];
	for (let d = startM; d < endM - 1; d += binSizeM) {
		const binEnd = Math.min(endM, d + binSizeM);
		const a = findPointAtDistance(points, d);
		const b = findPointAtDistance(points, binEnd);
		const run = b.cumDistM - a.cumDistM;
		if (run <= 0) continue;
		const grade = ((b.ele - a.ele) / run) * 100;
		bins.push({
			startM: a.cumDistM,
			endM: b.cumDistM,
			startEle: a.ele,
			endEle: b.ele,
			grade
		});
	}
	return bins;
}

// Vertical-deviation Douglas-Peucker. For elevation profiles the natural
// distance metric is |Δelevation|, not 2D perpendicular distance — distance
// and elevation live on totally different scales (10s of km vs 100s of m),
// so a true perpendicular-distance RDP would be dominated by the long axis.
// Returned `keep[i]` is true iff the i-th point survives simplification.
function rdpVertical(
	pts: { dist: number; ele: number }[],
	epsilonM: number
): boolean[] {
	const n = pts.length;
	const keep: boolean[] = new Array(n).fill(false);
	if (n === 0) return keep;
	keep[0] = true;
	keep[n - 1] = true;
	if (n < 3) return keep;

	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length > 0) {
		const [i, j] = stack.pop()!;
		if (j - i < 2) continue;
		const a = pts[i];
		const b = pts[j];
		const dx = b.dist - a.dist;
		let maxDev = 0;
		let maxK = -1;
		for (let k = i + 1; k < j; k++) {
			const t = dx > 0 ? (pts[k].dist - a.dist) / dx : 0;
			const lineEle = a.ele + (b.ele - a.ele) * t;
			const dev = Math.abs(pts[k].ele - lineEle);
			if (dev > maxDev) {
				maxDev = dev;
				maxK = k;
			}
		}
		if (maxDev > epsilonM && maxK !== -1) {
			keep[maxK] = true;
			stack.push([i, maxK]);
			stack.push([maxK, j]);
		}
	}
	return keep;
}

export function computeAdaptiveBins(
	points: RoutePoint[],
	startM: number,
	endM: number,
	epsilonM: number
): GradeBin[] {
	if (points.length < 2 || endM <= startM) return [];
	const a = findPointAtDistance(points, startM);
	const b = findPointAtDistance(points, endM);
	const sliced: { dist: number; ele: number }[] = [{ dist: a.cumDistM, ele: a.ele }];
	for (const p of points) {
		if (p.cumDistM <= a.cumDistM) continue;
		if (p.cumDistM >= b.cumDistM) break;
		sliced.push({ dist: p.cumDistM, ele: p.ele });
	}
	sliced.push({ dist: b.cumDistM, ele: b.ele });

	const keep = rdpVertical(sliced, epsilonM);
	const bins: GradeBin[] = [];
	let prev: { dist: number; ele: number } | null = null;
	for (let i = 0; i < sliced.length; i++) {
		if (!keep[i]) continue;
		const cur = sliced[i];
		if (prev) {
			const run = cur.dist - prev.dist;
			if (run > 0) {
				bins.push({
					startM: prev.dist,
					endM: cur.dist,
					startEle: prev.ele,
					endEle: cur.ele,
					grade: ((cur.ele - prev.ele) / run) * 100
				});
			}
		}
		prev = cur;
	}
	return bins;
}

// Cutoffs sit at half-integers so a grade that *rounds* to N falls in the same
// bucket as the integer label "N%". Without this, e.g. -0.95 displays as "-1%"
// but with `< -1` falls through to yellow, mismatching the slate-for-descent rule.
export function gradeColor(grade: number): string {
	if (grade < -0.5) return '#64748b';
	if (grade < 0.5) return '#eab308';
	if (grade < 2.5) return '#f59e0b';
	if (grade < 4.5) return '#f97316';
	if (grade < 6.5) return '#ea580c';
	if (grade < 8.5) return '#dc2626';
	if (grade < 11.5) return '#b91c1c';
	return '#7f1d1d';
}
