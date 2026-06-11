import { findPointAtDistance } from './elevation.js';
import type { RoutePoint } from './types.js';

// Climb autodetection. Pipeline:
//   1. resample the route at a fixed step (GPX point density varies wildly)
//   2. smooth elevation with a moving average (raw GPS elevation is noisy)
//   3. mark every step whose smoothed grade clears `climbGrade` and collect
//      maximal runs of climbing steps
//   4. tier-1 bridge: merge breathers (`maxGapM` / `maxGapLossM`) — short,
//      near-lossless false flats where the climb never really stops. The
//      merge is seamless: it never produces `parts`. Only allowed while the
//      merged stretch still averages `minAvgGrade`.
//   5. drop candidates that miss the length / gain / grade / score floors
//   6. tier-2 join: compose *adjacent qualified climbs* across a real
//      interruption (flat shelf or descent) when the gap is small relative
//      to the climbing it connects (`joinGapFrac` capped by `maxJoinGapM`,
//      loss within `joinLossFrac` of the combined gain, merged average
//      still ≥ `minAvgGrade`). The joined parent keeps the children as
//      `parts`, so the UI can offer A, B, and A+B.
//
// The two tiers carve the gap spectrum into three regimes: tiny breather →
// one seamless climb; real interruption → one climb with parts; anything
// bigger → separate climbs.
//
// Everything is computed on the smoothed profile, so reported gains run a
// touch under what computeCropStats' 50m-window ascent shows for the same
// crop. Detection results feed the UI as *suggestions*; placing markers and
// saving segments stays a user action.

export type ClimbCategory = 'HC' | '1' | '2' | '3' | '4';

export type DetectedClimb = {
	startM: number;
	endM: number;
	lengthM: number;
	gainM: number;
	avgGrade: number;
	/** Steepest 200 m stretch, % (falls back to avgGrade on shorter climbs). */
	maxGrade: number;
	startEleM: number;
	topEleM: number;
	/** Strava-style difficulty: lengthM × avgGrade(%). */
	score: number;
	fiets: number;
	category: ClimbCategory | null;
	/**
	 * When tier-2 joining composed ≥ 2 qualified climbs across a real
	 * interruption, the children are kept here (leaves only, one level deep)
	 * so the UI can offer A, B, and A+B. Parts tile the parent: each is a
	 * full qualified climb in its own right. Absent on seamless climbs —
	 * tier-1 false-flat bridging never produces parts.
	 */
	parts?: DetectedClimb[];
};

export type ClimbDetectionParams = {
	sampleStepM: number;
	smoothWindowM: number;
	/** A step counts as climbing when its smoothed grade is at least this, %. */
	climbGrade: number;
	/** Tier 1: seamlessly merge breathers up to this long… */
	maxGapM: number;
	/** …as long as they lose no more than this much elevation. */
	maxGapLossM: number;
	/** Tier 2: join neighboring qualified climbs across a gap up to this
	 * fraction of their combined length… */
	joinGapFrac: number;
	/** …capped at this absolute gap length… */
	maxJoinGapM: number;
	/** …losing at most this fraction of their combined gain. */
	joinLossFrac: number;
	minLengthM: number;
	minGainM: number;
	minAvgGrade: number;
	minScore: number;
};

export type SensitivityPreset = 'strict' | 'balanced' | 'sensitive';

// strict = only serious, categorized-grade climbs, with aggressive tier-1
// bridging so a long alpine climb survives its false flats in one piece.
// sensitive = every little kicker, with small gaps so neighboring bumps
// stay separate instead of merging into one mushy candidate.
export const DETECTION_PRESETS: Record<SensitivityPreset, ClimbDetectionParams> = {
	strict: {
		sampleStepM: 25,
		smoothWindowM: 150,
		climbGrade: 2.5,
		maxGapM: 800,
		maxGapLossM: 25,
		joinGapFrac: 0.35,
		maxJoinGapM: 3000,
		joinLossFrac: 0.3,
		minLengthM: 1000,
		minGainM: 80,
		minAvgGrade: 3.5,
		minScore: 8000
	},
	balanced: {
		sampleStepM: 25,
		smoothWindowM: 100,
		climbGrade: 2,
		maxGapM: 400,
		maxGapLossM: 15,
		joinGapFrac: 0.4,
		maxJoinGapM: 2500,
		joinLossFrac: 0.35,
		minLengthM: 500,
		minGainM: 40,
		minAvgGrade: 3,
		minScore: 3000
	},
	sensitive: {
		sampleStepM: 25,
		smoothWindowM: 75,
		climbGrade: 1.5,
		maxGapM: 300,
		maxGapLossM: 20,
		joinGapFrac: 0.4,
		maxJoinGapM: 1500,
		joinLossFrac: 0.35,
		minLengthM: 300,
		minGainM: 20,
		minAvgGrade: 2,
		minScore: 1000
	}
};

const MAX_GRADE_WINDOW_M = 200;

// Strava only categorizes climbs averaging ≥ 3% — a 10 km false flat can
// rack up a big score without ever feeling like a climb.
const CATEGORY_MIN_GRADE = 3;

export function climbCategory(score: number, avgGrade: number): ClimbCategory | null {
	if (avgGrade < CATEGORY_MIN_GRADE) return null;
	if (score >= 80000) return 'HC';
	if (score >= 64000) return '1';
	if (score >= 32000) return '2';
	if (score >= 16000) return '3';
	if (score >= 8000) return '4';
	return null;
}

// FIETS index: rise²/(length·10), plus an altitude bonus above 1000 m.
// Alpe d'Huez (~1071 m over ~13.8 km, top 1850 m) lands around 9.
export function fietsIndex(riseM: number, lengthM: number, topEleM: number): number {
	if (lengthM <= 0) return 0;
	return (riseM * riseM) / (lengthM * 10) + Math.max(0, topEleM - 1000) / 1000;
}

// Badge colors, matched to the gradeColor palette (harder = redder, HC = black).
export function categoryColor(category: ClimbCategory | null): string {
	switch (category) {
		case 'HC':
			return '#171717';
		case '1':
			return '#b91c1c';
		case '2':
			return '#ea580c';
		case '3':
			return '#f59e0b';
		case '4':
			return '#eab308';
		default:
			return '#a3a3a3';
	}
}

type Run = { i0: number; i1: number }; // inclusive range of climbing steps

export function detectClimbs(
	points: RoutePoint[],
	params: Partial<ClimbDetectionParams> = {}
): DetectedClimb[] {
	const p: ClimbDetectionParams = { ...DETECTION_PRESETS.balanced, ...params };
	if (points.length < 2) return [];
	const totalM = points[points.length - 1].cumDistM;
	if (totalM < p.minLengthM) return [];

	// 1. Resample. The tail sample is only kept when it adds at least half a
	// step, so the final grade interval never collapses to a noisy sliver.
	const step = p.sampleStepM;
	const n = Math.floor(totalM / step);
	const dist: number[] = [];
	const raw: number[] = [];
	for (let i = 0; i <= n; i++) {
		dist.push(i * step);
		raw.push(findPointAtDistance(points, i * step).ele);
	}
	if (totalM - n * step >= step / 2) {
		dist.push(totalM);
		raw.push(findPointAtDistance(points, totalM).ele);
	}
	const m = dist.length;
	if (m < 3) return [];

	// 2. Smooth via prefix sums (window truncates at the ends).
	const halfN = Math.max(1, Math.round(p.smoothWindowM / 2 / step));
	const prefix = new Array<number>(m + 1).fill(0);
	for (let i = 0; i < m; i++) prefix[i + 1] = prefix[i] + raw[i];
	const ele = new Array<number>(m);
	for (let i = 0; i < m; i++) {
		const a = Math.max(0, i - halfN);
		const b = Math.min(m - 1, i + halfN);
		ele[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
	}

	// 3. Climbing runs.
	const runs: Run[] = [];
	let cur: Run | null = null;
	for (let i = 0; i < m - 1; i++) {
		const run = dist[i + 1] - dist[i];
		const grade = run > 0 ? ((ele[i + 1] - ele[i]) / run) * 100 : 0;
		if (grade >= p.climbGrade) {
			if (cur) cur.i1 = i;
			else cur = { i0: i, i1: i };
		} else if (cur) {
			runs.push(cur);
			cur = null;
		}
	}
	if (cur) runs.push(cur);

	// 4. Tier 1 — continuity bridging: a breather short and lossless enough
	// that the climb never really stops. Seamless; never yields parts.
	const groups: Run[] = [];
	for (const run of runs) {
		const prev = groups[groups.length - 1];
		if (prev) {
			const gapLen = dist[run.i0] - dist[prev.i1 + 1];
			const gapLoss = Math.max(0, ele[prev.i1 + 1] - ele[run.i0]);
			const len = dist[run.i1 + 1] - dist[prev.i0];
			const gain = ele[run.i1 + 1] - ele[prev.i0];
			const avg = len > 0 ? (gain / len) * 100 : 0;
			if (gapLen <= p.maxGapM && gapLoss <= p.maxGapLossM && avg >= p.minAvgGrade) {
				prev.i1 = run.i1;
				continue;
			}
		}
		groups.push({ ...run });
	}

	// Stats + the length/gain/grade/score floors for one run; null = rejected.
	const buildClimb = (r: Run): DetectedClimb | null => {
		const startM = dist[r.i0];
		const endM = dist[r.i1 + 1];
		const lengthM = endM - startM;
		const startEleM = ele[r.i0];
		const gainM = ele[r.i1 + 1] - startEleM;
		const avgGrade = lengthM > 0 ? (gainM / lengthM) * 100 : 0;
		const score = lengthM * avgGrade;
		if (
			lengthM < p.minLengthM ||
			gainM < p.minGainM ||
			avgGrade < p.minAvgGrade ||
			score < p.minScore
		) {
			return null;
		}

		let topEleM = startEleM;
		for (let i = r.i0; i <= r.i1 + 1; i++) topEleM = Math.max(topEleM, ele[i]);

		// Steepest >= 200 m window: shrink j until the window is minimal.
		let maxGrade = avgGrade;
		let j = r.i0;
		for (let k = r.i0 + 1; k <= r.i1 + 1; k++) {
			while (dist[k] - dist[j + 1] >= MAX_GRADE_WINDOW_M) j++;
			const span = dist[k] - dist[j];
			if (span >= MAX_GRADE_WINDOW_M) {
				maxGrade = Math.max(maxGrade, ((ele[k] - ele[j]) / span) * 100);
			}
		}

		return {
			startM,
			endM,
			lengthM,
			gainM,
			avgGrade,
			maxGrade,
			startEleM,
			topEleM,
			score,
			fiets: fietsIndex(topEleM - startEleM, lengthM, topEleM),
			category: climbCategory(score, avgGrade)
		};
	};

	// 5. Floors. Keep each survivor's index range for the join pass.
	const qualified: { run: Run; climb: DetectedClimb }[] = [];
	for (const g of groups) {
		const climb = buildClimb(g);
		if (climb) qualified.push({ run: g, climb });
	}

	// 6. Tier 2 — composition: join adjacent qualified climbs across a real
	// interruption (flat shelf or descent) when the gap is small relative to
	// the climbing it connects. Gap budgets scale with the *children* (the
	// actual climbing), while the merged-average guard runs over the full
	// span including the gap, so a descent can't dilute the parent into a
	// non-climb. Qualified climbs are disjoint and ordered, so so is the
	// output.
	const out: DetectedClimb[] = [];
	let cluster: { run: Run; climb: DetectedClimb }[] = [];
	const flush = () => {
		if (cluster.length === 1) {
			out.push(cluster[0].climb);
		} else if (cluster.length >= 2) {
			const parent = buildClimb({
				i0: cluster[0].run.i0,
				i1: cluster[cluster.length - 1].run.i1
			});
			// The join guard re-checks the floors at every extension, so the
			// parent always builds; the fallback is just type-level safety.
			if (parent) {
				parent.parts = cluster.map((c) => c.climb);
				out.push(parent);
			} else {
				out.push(...cluster.map((c) => c.climb));
			}
		}
		cluster = [];
	};
	for (const q of qualified) {
		const last = cluster[cluster.length - 1];
		if (last) {
			const gapLen = dist[q.run.i0] - dist[last.run.i1 + 1];
			const gapLoss = Math.max(0, ele[last.run.i1 + 1] - ele[q.run.i0]);
			const childLen = cluster.reduce((s, c) => s + c.climb.lengthM, q.climb.lengthM);
			const childGain = cluster.reduce((s, c) => s + c.climb.gainM, q.climb.gainM);
			const merged = buildClimb({ i0: cluster[0].run.i0, i1: q.run.i1 });
			if (
				gapLen <= Math.min(p.maxJoinGapM, p.joinGapFrac * childLen) &&
				gapLoss <= p.joinLossFrac * childGain &&
				merged != null
			) {
				cluster.push(q);
				continue;
			}
		}
		flush();
		cluster = [q];
	}
	flush();
	return out;
}
