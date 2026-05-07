// Pure orthographic-projection math for the segment topo view.
//
// Pipeline: world (lat, lon, ele) → metres around route center → rotated by
// (yaw, pitch) → mapped to SVG via a single `dimensions.scale` chosen to fit
// the route in the canvas. Returns `[svgX, svgY, depth]`; `depth` is the
// rotated z and feeds the painter's-algorithm sort so closer geometry draws
// on top. SVG y grows downward, so the projection negates the rotated y.

export const M_PER_DEG = 111_111;
export const VB_W = 1600;
export const PAD = 32;

// Aspect clamping so neither very-portrait nor very-wide routes produce
// extreme rectangles. Portrait gets whitespace on the sides; very wide gets
// whitespace above/below.
export const MIN_CANVAS_ASPECT = 1.5;
export const MAX_CANVAS_ASPECT = 3;

export type RefFrame = {
	centerLat: number;
	centerLon: number;
	centerEle: number;
	cosLat: number;
	xSpanM: number;
	ySpanM: number;
	minEle: number;
	maxEle: number;
};

export type Dimensions = {
	W: number;
	H: number;
	innerW: number;
	innerH: number;
	scale: number;
};

export type Projected = [number, number, number];

export type ProjectCtx = {
	refFrame: RefFrame;
	dimensions: Dimensions;
	yaw: number;
	pitch: number;
	zExaggeration: number;
};

export function rotate3d(
	x: number,
	y: number,
	z: number,
	yawRad: number,
	pitchRad: number
): [number, number, number] {
	const cy = Math.cos(yawRad);
	const sy = Math.sin(yawRad);
	const x1 = x * cy - y * sy;
	const y1 = x * sy + y * cy;
	const z1 = z;
	const cp = Math.cos(pitchRad);
	const sp = Math.sin(pitchRad);
	// Pitch: tilting the world forward (pitch>0) raises high-z points on
	// screen (smaller SVG y) — equivalent to camera tilting up.
	const y2 = y1 * cp + z1 * sp;
	const z2 = -y1 * sp + z1 * cp;
	return [x1, y2, z2];
}

// Build the reference frame from a set of points. Returns null if there's
// nothing to project (fewer than two points means no extent).
export function computeRefFrame(
	points: readonly { lat: number; lon: number; ele: number }[]
): RefFrame | null {
	if (points.length < 2) return null;
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	let minEle = Infinity;
	let maxEle = -Infinity;
	for (const p of points) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lon < minLon) minLon = p.lon;
		if (p.lon > maxLon) maxLon = p.lon;
		if (p.ele < minEle) minEle = p.ele;
		if (p.ele > maxEle) maxEle = p.ele;
	}
	const centerLat = (minLat + maxLat) / 2;
	const centerLon = (minLon + maxLon) / 2;
	const centerEle = (minEle + maxEle) / 2;
	const cosLat = Math.cos((centerLat * Math.PI) / 180);
	// Floor the spans at 1m so a degenerate (zero-extent) bbox doesn't
	// produce a divide-by-zero in computeDimensions.
	const xSpanM = Math.max(1, (maxLon - minLon) * cosLat * M_PER_DEG);
	const ySpanM = Math.max(1, (maxLat - minLat) * M_PER_DEG);
	return { centerLat, centerLon, centerEle, cosLat, xSpanM, ySpanM, minEle, maxEle };
}

// Default dimensions used when there's no data yet. Matches the values the
// SVG viewBox needs before refFrame is available.
const DEFAULT_DIMENSIONS: Dimensions = {
	W: VB_W,
	H: 600,
	innerW: VB_W - PAD * 2,
	innerH: 536,
	scale: 1
};

export function computeDimensions(
	refFrame: RefFrame | null,
	canvasAspect: number
): Dimensions {
	if (!refFrame) return DEFAULT_DIMENSIONS;
	const innerW = VB_W - PAD * 2;
	const innerH = innerW / canvasAspect;
	const H = innerH + PAD * 2;
	// Pick the smaller of the two scales so the route fits in both axes,
	// preserving aspect (no squishing).
	const scaleByW = innerW / refFrame.xSpanM;
	const scaleByH = innerH / refFrame.ySpanM;
	const scale = Math.min(scaleByW, scaleByH);
	return { W: VB_W, H, innerW, innerH, scale };
}

// Clamp an aspect ratio against MIN/MAX_CANVAS_ASPECT, falling back to
// MIN if there's no data yet.
export function clampDataAspect(refFrame: RefFrame | null): number {
	if (!refFrame) return MIN_CANVAS_ASPECT;
	const trueAspect = refFrame.xSpanM / refFrame.ySpanM;
	return Math.max(MIN_CANVAS_ASPECT, Math.min(MAX_CANVAS_ASPECT, trueAspect));
}

export function projectLLE(
	lat: number,
	lon: number,
	ele: number,
	ctx: ProjectCtx
): Projected {
	const { refFrame, dimensions, yaw, pitch, zExaggeration } = ctx;
	const xm = (lon - refFrame.centerLon) * refFrame.cosLat * M_PER_DEG;
	const ym = (lat - refFrame.centerLat) * M_PER_DEG;
	const zm = (ele - refFrame.centerEle) * zExaggeration;
	const [vx, vy, vz] = rotate3d(xm, ym, zm, yaw, pitch);
	const cx = VB_W / 2;
	const cy = dimensions.H / 2;
	const sx = cx + vx * dimensions.scale;
	const sy = cy - vy * dimensions.scale; // SVG y grows downward
	return [sx, sy, vz];
}

// Bind a projection context once and return a function that projects a
// (lat, lon, ele) tuple — convenient for callers that project many points
// against the same context (e.g. building a polyline).
export function makeProjector(
	ctx: ProjectCtx
): (lat: number, lon: number, ele: number) => Projected {
	return (lat, lon, ele) => projectLLE(lat, lon, ele, ctx);
}
