<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { findPointAtDistance, gradeColor, type GradeBin } from '$lib/elevation.js';
	import type { RoutePoint } from '$lib/types.js';

	type Props = {
		points: RoutePoint[];
		startDistM: number;
		endDistM: number;
		bins: GradeBin[];
		hoverDistM?: number | null;
		externalHoverDistM?: number | null;
	};
	let {
		points,
		startDistM,
		endDistM,
		bins,
		hoverDistM = $bindable(null),
		externalHoverDistM = null
	}: Props = $props();

	const VB_W = 1600;
	const PAD = 32;
	const STROKE = 6;
	const DRAG_THRESHOLD_PX = 4;
	const ZOOM_FACTOR = 0.85;
	const MIN_VIEW_FRAC = 0.05;
	const MAX_VIEW_FRAC = 3;
	const HOVER_PX = 24;
	const M_PER_DEG = 111111;
	const ANCHOR_STEP_M = 250;
	const TILE_SIZE = 256;
	const TILE_BBOX_PAD = 0.1; // 10% lat/lon padding around the route bbox
	const TILE_MAX_TILES_PER_AXIS = 6;
	const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
	const TILE_FADE_START = Math.PI / 4;
	const TILE_FADE_END = Math.PI / 2 - 0.05;
	const BLOCK_DEPTH_M = 100; // metres of "earth" the ground sits on

	let zExaggeration = $state(3);
	// Rotation sensitivity (radians per CSS pixel of drag). Pitch is negative
	// so dragging down tilts the camera up (Strava convention).
	const YAW_PER_PX = 0.005;
	const PITCH_PER_PX = -0.005;
	const PITCH_MAX = Math.PI / 2 - 0.05;

	let wrapperEl: HTMLDivElement | null = $state(null);
	let svgEl: SVGSVGElement | null = $state(null);

	let yaw = $state(0);
	let pitch = $state(0);

	// 2D/3D toggle state. is3D == pitch raised; yaw alone (top-down rotated)
	// still counts as 2D. The "saved" pose mirrors live (pitch, yaw) via effect
	// while in 3D, so flattening and toggling back restores whatever the user
	// was on — even poses reached via drag rather than the toggle.
	const PITCH_PRESET_3D = Math.PI / 4;
	let savedPitch = $state<number | null>(null);
	let savedYaw = $state<number | null>(null);
	const is3D = $derived(pitch > 0.01);
	$effect(() => {
		if (pitch > 0.01) {
			savedPitch = pitch;
			savedYaw = yaw;
		}
	});

	function toggle3D() {
		if (is3D) {
			pitch = 0;
			yaw = 0;
		} else {
			pitch = savedPitch ?? PITCH_PRESET_3D;
			yaw = savedYaw ?? 0;
		}
	}

	// User-resized height (px). null = use data-derived aspect.
	let userHeight = $state<number | null>(null);
	let wrapperWidth = $state(0);
	const USER_HEIGHT_MIN = 240;
	const USER_HEIGHT_MAX = 1400;

	let showMap = $state(true);
	let showAnchorLines = $state(true);

	let showVertPopover = $state(false);
	let vertHideTimer: ReturnType<typeof setTimeout> | null = null;
	function openVert() {
		if (vertHideTimer) {
			clearTimeout(vertHideTimer);
			vertHideTimer = null;
		}
		showVertPopover = true;
	}
	function closeVert() {
		if (vertHideTimer) clearTimeout(vertHideTimer);
		// Small delay so the cursor can travel from button to popover (or back)
		// without the popover snapping shut mid-transit.
		vertHideTimer = setTimeout(() => {
			showVertPopover = false;
			vertHideTimer = null;
		}, 120);
	}

	// Clamp to exact start/end via interpolation so the route polyline, end
	// dot, and boundary anchor lines all terminate at the same point — without
	// this the polyline ends at the last GPX point ≤ endDistM, while distance-
	// based features (anchor lines) interpolate to the true segment end.
	const slicedPoints = $derived.by(() => {
		if (points.length === 0) return [] as RoutePoint[];
		const a = findPointAtDistance(points, startDistM);
		const b = findPointAtDistance(points, endDistM);
		const out: RoutePoint[] = [
			{ lat: a.lat, lon: a.lon, ele: a.ele, cumDistM: a.cumDistM }
		];
		for (const p of points) {
			if (p.cumDistM <= a.cumDistM) continue;
			if (p.cumDistM >= b.cumDistM) break;
			out.push(p);
		}
		out.push({ lat: b.lat, lon: b.lon, ele: b.ele, cumDistM: b.cumDistM });
		return out;
	});

	// Reference frame: route center in lat/lon/ele, plus 2D extents in metres.
	// The 2D extents fix the canvas size — we scale rotated points using this
	// reference scale so layout doesn't jitter as the user rotates.
	const refFrame = $derived.by(() => {
		if (slicedPoints.length < 2) return null;
		let minLat = Infinity;
		let maxLat = -Infinity;
		let minLon = Infinity;
		let maxLon = -Infinity;
		let minEle = Infinity;
		let maxEle = -Infinity;
		for (const p of slicedPoints) {
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
		const xSpanM = Math.max(1, (maxLon - minLon) * cosLat * M_PER_DEG);
		const ySpanM = Math.max(1, (maxLat - minLat) * M_PER_DEG);
		return { centerLat, centerLon, centerEle, cosLat, xSpanM, ySpanM, minEle, maxEle };
	});

	// Don't let the canvas grow taller than 1 / MIN_CANVAS_ASPECT of its width.
	// Without this, a portrait route (high lat span, low lon span) projects
	// into a comically tall canvas. Clamping makes the canvas at most 3:2
	// landscape; portrait routes get vertical fit + side whitespace instead.
	const MIN_CANVAS_ASPECT = 1.5;

	const dimensions = $derived.by(() => {
		if (!refFrame) return { W: VB_W, H: 600, innerW: VB_W - PAD * 2, innerH: 536, scale: 1 };
		const innerW = VB_W - PAD * 2;
		const trueAspect = refFrame.xSpanM / refFrame.ySpanM;
		const dataAspect = Math.max(MIN_CANVAS_ASPECT, trueAspect);
		// When the user has resized, match the actual rendered aspect so the SVG
		// fills the wrapper without letterboxing.
		const canvasAspect =
			userHeight && wrapperWidth ? wrapperWidth / userHeight : dataAspect;
		const innerH = innerW / canvasAspect;
		const H = innerH + PAD * 2;
		// Pick the smaller of the two scales so the route fits in both axes,
		// preserving aspect (no squishing).
		const scaleByW = innerW / refFrame.xSpanM;
		const scaleByH = innerH / refFrame.ySpanM;
		const scale = Math.min(scaleByW, scaleByH);
		return { W: VB_W, H, innerW, innerH, scale };
	});

	function rotate3d(
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

	// Project a (lat, lon, ele) tuple into [svg_x, svg_y, depth_metres].
	// At yaw=0, pitch=0 this matches the previous 2D top-down projection.
	function projectLLE(lat: number, lon: number, ele: number): [number, number, number] {
		if (!refFrame) return [VB_W / 2, dimensions.H / 2, 0];
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

	function project3d(p: RoutePoint): [number, number, number] {
		return projectLLE(p.lat, p.lon, p.ele);
	}

	// Standard slippy-tile <-> lat/lon math.
	function lonToTileX(lon: number, z: number): number {
		return ((lon + 180) / 360) * Math.pow(2, z);
	}
	function latToTileY(lat: number, z: number): number {
		const r = (lat * Math.PI) / 180;
		return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
	}
	function tileXToLon(x: number, z: number): number {
		return (x / Math.pow(2, z)) * 360 - 180;
	}
	function tileYToLat(y: number, z: number): number {
		const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
		return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
	}

	function pickTileZoom(bbox: {
		minLat: number;
		maxLat: number;
		minLon: number;
		maxLon: number;
	}): number {
		// Highest zoom that keeps the tile grid <= TILE_MAX_TILES_PER_AXIS.
		for (let z = 18; z >= 1; z--) {
			const xRange = lonToTileX(bbox.maxLon, z) - lonToTileX(bbox.minLon, z);
			const yRange = latToTileY(bbox.minLat, z) - latToTileY(bbox.maxLat, z);
			if (xRange <= TILE_MAX_TILES_PER_AXIS && yRange <= TILE_MAX_TILES_PER_AXIS) {
				return z;
			}
		}
		return 1;
	}

	type TileImage = {
		url: string;
		minLat: number;
		maxLat: number;
		minLon: number;
		maxLon: number;
	};

	async function buildTileImage(
		bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
		zoom: number
	): Promise<TileImage | null> {
		const xMin = Math.floor(lonToTileX(bbox.minLon, zoom));
		const xMax = Math.ceil(lonToTileX(bbox.maxLon, zoom));
		const yMin = Math.floor(latToTileY(bbox.maxLat, zoom));
		const yMax = Math.ceil(latToTileY(bbox.minLat, zoom));

		const w = (xMax - xMin) * TILE_SIZE;
		const h = (yMax - yMin) * TILE_SIZE;
		if (w <= 0 || h <= 0) return null;

		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.fillStyle = '#f4f4f5';
		ctx.fillRect(0, 0, w, h);

		const loads: Promise<void>[] = [];
		for (let x = xMin; x < xMax; x++) {
			for (let y = yMin; y < yMax; y++) {
				const url = TILE_URL_TEMPLATE.replace('{z}', String(zoom))
					.replace('{x}', String(x))
					.replace('{y}', String(y));
				const img = new Image();
				img.crossOrigin = 'anonymous';
				const px = (x - xMin) * TILE_SIZE;
				const py = (y - yMin) * TILE_SIZE;
				loads.push(
					new Promise<void>((resolve) => {
						img.onload = () => {
							ctx.drawImage(img, px, py);
							resolve();
						};
						img.onerror = () => resolve(); // skip missing tiles silently
						img.src = url;
					})
				);
			}
		}
		await Promise.all(loads);

		// Crop the composited canvas down to the *requested* bbox so its edges
		// align with the route bbox + padding. Without this the tile image keeps
		// the floor/ceil overhang to whole-tile boundaries, which is
		// asymmetric around the route — visibly more "map" on one side.
		const cropX0 = Math.max(0, (lonToTileX(bbox.minLon, zoom) - xMin) * TILE_SIZE);
		const cropX1 = Math.min(w, (lonToTileX(bbox.maxLon, zoom) - xMin) * TILE_SIZE);
		const cropY0 = Math.max(0, (latToTileY(bbox.maxLat, zoom) - yMin) * TILE_SIZE);
		const cropY1 = Math.min(h, (latToTileY(bbox.minLat, zoom) - yMin) * TILE_SIZE);
		const cw = Math.round(cropX1 - cropX0);
		const ch = Math.round(cropY1 - cropY0);
		if (cw <= 0 || ch <= 0) return null;

		const cropped = document.createElement('canvas');
		cropped.width = cw;
		cropped.height = ch;
		const cctx = cropped.getContext('2d');
		if (!cctx) return null;
		cctx.drawImage(canvas, cropX0, cropY0, cw, ch, 0, 0, cw, ch);

		return {
			url: cropped.toDataURL('image/png'),
			minLon: bbox.minLon,
			maxLon: bbox.maxLon,
			maxLat: bbox.maxLat,
			minLat: bbox.minLat
		};
	}

	let tileImage = $state<TileImage | null>(null);

	$effect(() => {
		if (!refFrame || slicedPoints.length < 2) {
			tileImage = null;
			return;
		}
		let minLat = Infinity;
		let maxLat = -Infinity;
		let minLon = Infinity;
		let maxLon = -Infinity;
		for (const p of slicedPoints) {
			if (p.lat < minLat) minLat = p.lat;
			if (p.lat > maxLat) maxLat = p.lat;
			if (p.lon < minLon) minLon = p.lon;
			if (p.lon > maxLon) maxLon = p.lon;
		}
		const baseLatPad = (maxLat - minLat) * TILE_BBOX_PAD;
		const baseLonPad = (maxLon - minLon) * TILE_BBOX_PAD;

		// Extend the tile bbox to cover the canvas, not just the route. For a
		// portrait route in a landscape canvas the route alone leaves a narrow
		// strip of map; here we compute how many extra metres we need on each
		// axis to fill the canvas after the fit-contain projection, then
		// translate that back into lat/lon padding.
		const trueAspect = refFrame.xSpanM / refFrame.ySpanM;
		const canvasAspect = Math.max(MIN_CANVAS_ASPECT, trueAspect);
		const canvasXspanM =
			canvasAspect > trueAspect ? canvasAspect * refFrame.ySpanM : refFrame.xSpanM;
		const canvasYspanM =
			canvasAspect > trueAspect ? refFrame.ySpanM : refFrame.xSpanM / canvasAspect;
		const extraLonPad =
			Math.max(0, canvasXspanM - refFrame.xSpanM) / 2 / (refFrame.cosLat * M_PER_DEG);
		const extraLatPad = Math.max(0, canvasYspanM - refFrame.ySpanM) / 2 / M_PER_DEG;

		const lonPad = Math.max(baseLonPad, extraLonPad);
		const latPad = Math.max(baseLatPad, extraLatPad);
		const padded = {
			minLat: minLat - latPad,
			maxLat: maxLat + latPad,
			minLon: minLon - lonPad,
			maxLon: maxLon + lonPad
		};
		const zoom = pickTileZoom(padded);
		let cancelled = false;
		buildTileImage(padded, zoom)
			.then((result) => {
				if (cancelled) return;
				tileImage = result;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	// Map the snapshot's lat/lon corners onto the rotated ground plane and
	// derive the affine transform that places the image as the right
	// parallelogram. Orthographic projection means a planar rectangle stays
	// a parallelogram under any rotation, so an affine matrix is sufficient.
	const tileTransform = $derived.by(() => {
		if (!tileImage || !refFrame) return null;
		const ground = refFrame.minEle;
		const tl = projectLLE(tileImage.maxLat, tileImage.minLon, ground); // north-west
		const tr = projectLLE(tileImage.maxLat, tileImage.maxLon, ground); // north-east
		const bl = projectLLE(tileImage.minLat, tileImage.minLon, ground); // south-west
		return {
			a: tr[0] - tl[0],
			b: tr[1] - tl[1],
			c: bl[0] - tl[0],
			d: bl[1] - tl[1],
			e: tl[0],
			f: tl[1]
		};
	});

	const tileOpacity = $derived.by(() => {
		if (pitch <= TILE_FADE_START) return 1;
		if (pitch >= TILE_FADE_END) return 0;
		return 1 - (pitch - TILE_FADE_START) / (TILE_FADE_END - TILE_FADE_START);
	});

	// Side faces of the "earth block" the OSM ground sits on. Each face is a
	// parallelogram (top edge at minEle, bottom edge at minEle - BLOCK_DEPTH_M).
	// Sorted back-to-front so painter's algorithm hides the rear faces.
	const blockFaces = $derived.by(() => {
		if (!tileImage || !refFrame) return [];
		const top = refFrame.minEle;
		const bot = refFrame.minEle - BLOCK_DEPTH_M;
		// Top corners
		const nwT = projectLLE(tileImage.maxLat, tileImage.minLon, top);
		const neT = projectLLE(tileImage.maxLat, tileImage.maxLon, top);
		const seT = projectLLE(tileImage.minLat, tileImage.maxLon, top);
		const swT = projectLLE(tileImage.minLat, tileImage.minLon, top);
		// Bottom corners
		const nwB = projectLLE(tileImage.maxLat, tileImage.minLon, bot);
		const neB = projectLLE(tileImage.maxLat, tileImage.maxLon, bot);
		const seB = projectLLE(tileImage.minLat, tileImage.maxLon, bot);
		const swB = projectLLE(tileImage.minLat, tileImage.minLon, bot);

		const faces = [
			{ name: 'N', corners: [nwT, neT, neB, nwB] },
			{ name: 'E', corners: [neT, seT, seB, neB] },
			{ name: 'S', corners: [seT, swT, swB, seB] },
			{ name: 'W', corners: [swT, nwT, nwB, swB] }
		];

		const out = faces.map((f) => {
			const pts = f.corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
			const depth = (f.corners[0][2] + f.corners[1][2] + f.corners[2][2] + f.corners[3][2]) / 4;
			return { points: pts, depth };
		});
		// Lower depth (further from camera) first.
		out.sort((a, b) => a.depth - b.depth);
		return out;
	});

	const projectedPoints = $derived(slicedPoints.map((p) => project3d(p)));

	// Flat ground-projected shadow of the route — every point lifted (or rather
	// dropped) to the segment's minimum elevation. At pitch=0 it overlaps the
	// real route exactly, so the top-down view is unchanged. As you tilt, the
	// shadow separates and anchors the route to the ground plane.
	const shadowPoints = $derived.by(() => {
		if (!refFrame || slicedPoints.length < 2) return '';
		const parts: string[] = [];
		for (const p of slicedPoints) {
			const [x, y] = projectLLE(p.lat, p.lon, refFrame.minEle);
			parts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		}
		return parts.join(' ');
	});

	// Subtle vertical anchor lines from the route surface down to the segment's
	// lowest elevation. At pitch=0 these collapse to zero length so the top-down
	// view is unchanged. Sampled at fixed distance intervals so density stays
	// stable regardless of the route's GPX point density.
	const anchorLines = $derived.by(() => {
		const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
		if (!refFrame || endDistM <= startDistM) return out;
		for (let d = startDistM; d <= endDistM + 1e-3; d += ANCHOR_STEP_M) {
			const distM = Math.min(d, endDistM);
			const ip = findPointAtDistance(points, distM);
			const [tx, ty] = projectLLE(ip.lat, ip.lon, ip.ele);
			const [bx, by] = projectLLE(ip.lat, ip.lon, refFrame.minEle);
			out.push({ x1: tx, y1: ty, x2: bx, y2: by });
		}
		return out;
	});

	// Heavier anchor lines at each segment-bin boundary, colored by the bin
	// that ends at the boundary. Anchors the last point (start is anchored by
	// the green start dot already).
	const boundaryAnchors = $derived.by(() => {
		const out: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
		if (!refFrame || bins.length === 0) return out;
		for (const bin of bins) {
			const ip = findPointAtDistance(points, bin.endM);
			const [tx, ty] = projectLLE(ip.lat, ip.lon, ip.ele);
			const [bx, by] = projectLLE(ip.lat, ip.lon, refFrame.minEle);
			out.push({ x1: tx, y1: ty, x2: bx, y2: by, color: gradeColor(bin.grade) });
		}
		return out;
	});

	// Polyline runs of consecutive same-color segments, each tagged with an
	// average depth so we can render back-to-front (painter's algorithm).
	const polylines = $derived.by(() => {
		const out: { points: string; color: string; depth: number }[] = [];
		if (slicedPoints.length < 2 || !refFrame) return out;

		const segColors: string[] = new Array(slicedPoints.length - 1);
		let binIdx = 0;
		for (let i = 0; i < slicedPoints.length - 1; i++) {
			const midDist = (slicedPoints[i].cumDistM + slicedPoints[i + 1].cumDistM) / 2;
			while (binIdx < bins.length - 1 && bins[binIdx].endM < midDist) binIdx++;
			const grade = bins[binIdx]?.grade ?? 0;
			segColors[i] = gradeColor(grade);
		}

		let runStart = 0;
		for (let i = 0; i < segColors.length; i++) {
			const isLast = i === segColors.length - 1;
			const colorChanged = !isLast && segColors[i + 1] !== segColors[i];
			if (isLast || colorChanged) {
				const pts: string[] = [];
				let depthSum = 0;
				let depthCount = 0;
				for (let j = runStart; j <= i + 1; j++) {
					const [x, y, d] = projectedPoints[j];
					pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
					depthSum += d;
					depthCount++;
				}
				out.push({
					points: pts.join(' '),
					color: segColors[i],
					depth: depthCount > 0 ? depthSum / depthCount : 0
				});
				runStart = i + 1;
			}
		}
		// Back-to-front: lower depth (further from camera) first.
		out.sort((a, b) => a.depth - b.depth);
		return out;
	});

	const startEnd = $derived.by(() => {
		if (projectedPoints.length < 2) return null;
		return { a: projectedPoints[0], b: projectedPoints[projectedPoints.length - 1] };
	});

	// Reverse-highlight: when the chart reports a hovered distance, draw a
	// halo overlay along the corresponding section of the route polyline.
	const externalHoverPolyline = $derived.by(() => {
		if (externalHoverDistM == null || !refFrame) return '';
		let bin: GradeBin | null = null;
		for (const b of bins) {
			if (externalHoverDistM >= b.startM && externalHoverDistM <= b.endM) {
				bin = b;
				break;
			}
		}
		if (!bin) return '';
		const parts: string[] = [];
		const a = findPointAtDistance(points, bin.startM);
		const [ax, ay] = projectLLE(a.lat, a.lon, a.ele);
		parts.push(`${ax.toFixed(1)},${ay.toFixed(1)}`);
		for (const p of slicedPoints) {
			if (p.cumDistM <= bin.startM) continue;
			if (p.cumDistM >= bin.endM) break;
			const [x, y] = projectLLE(p.lat, p.lon, p.ele);
			parts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		}
		const z = findPointAtDistance(points, bin.endM);
		const [zx, zy] = projectLLE(z.lat, z.lon, z.ele);
		parts.push(`${zx.toFixed(1)},${zy.toFixed(1)}`);
		return parts.join(' ');
	});

	// Viewport (visible window in viewBox space).
	let viewport = $state<{ x: number; y: number; w: number; h: number } | null>(null);

	$effect(() => {
		if (viewport == null && refFrame != null) {
			viewport = { x: 0, y: 0, w: dimensions.W, h: dimensions.H };
		}
	});

	const isZoomed = $derived(
		viewport != null &&
			(Math.abs(viewport.x) > 0.5 ||
				Math.abs(viewport.y) > 0.5 ||
				Math.abs(viewport.w - dimensions.W) > 0.5 ||
				Math.abs(viewport.h - dimensions.H) > 0.5)
	);

	function clampViewportXY(v: { x: number; y: number; w: number; h: number }) {
		// Allow panning up to half the natural canvas past each edge so
		// rotated/tilted content that overflows the original box stays
		// reachable. If the viewport already covers natural+margin (very
		// zoomed out) we just center.
		const marginX = dimensions.W * 0.5;
		const marginY = dimensions.H * 0.5;
		const minX = -marginX;
		const maxX = dimensions.W + marginX - v.w;
		const minY = -marginY;
		const maxY = dimensions.H + marginY - v.h;
		const x =
			maxX < minX ? (dimensions.W - v.w) / 2 : Math.max(minX, Math.min(maxX, v.x));
		const y =
			maxY < minY ? (dimensions.H - v.h) / 2 : Math.max(minY, Math.min(maxY, v.y));
		return { x, y, w: v.w, h: v.h };
	}
	const isRotated = $derived(yaw !== 0 || pitch !== 0);
	const isViewModified = $derived(isZoomed || isRotated);

	const viewBoxAttr = $derived(
		viewport
			? `${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`
			: `0 0 ${dimensions.W} ${dimensions.H}`
	);

	function resetView(e?: Event) {
		e?.stopPropagation();
		viewport = { x: 0, y: 0, w: dimensions.W, h: dimensions.H };
		yaw = 0;
		pitch = 0;
	}

	function onWheel(e: WheelEvent) {
		if (!svgEl || !viewport) return;
		e.preventDefault();
		const rect = svgEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const relX = (e.clientX - rect.left) / rect.width;
		const relY = (e.clientY - rect.top) / rect.height;
		const cursorSvgX = viewport.x + relX * viewport.w;
		const cursorSvgY = viewport.y + relY * viewport.h;
		const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
		const minW = dimensions.W * MIN_VIEW_FRAC;
		const maxW = dimensions.W * MAX_VIEW_FRAC;
		const newW = Math.max(minW, Math.min(maxW, viewport.w * factor));
		const actualFactor = newW / viewport.w;
		const newH = viewport.h * actualFactor;
		const newX = cursorSvgX - relX * newW;
		const newY = cursorSvgY - relY * newH;
		viewport = clampViewportXY({ x: newX, y: newY, w: newW, h: newH });
	}

	type DragMode = 'pan' | 'rotate';
	let isDragging = false;
	let dragMode: DragMode = 'pan';
	let dragStart: {
		clientX: number;
		clientY: number;
		vp: { x: number; y: number; w: number; h: number };
		yaw: number;
		pitch: number;
	} | null = null;
	let dragMoved = false;

	function isRotateModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
		return e.ctrlKey || e.metaKey;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0 || !viewport) return;
		// Ctrl/Cmd on pointerdown opens contextmenu by default on some platforms;
		// preventDefault keeps our handler in control.
		if (isRotateModifier(e)) e.preventDefault();
		isDragging = true;
		dragMode = isRotateModifier(e) ? 'rotate' : 'pan';
		dragStart = {
			clientX: e.clientX,
			clientY: e.clientY,
			vp: { ...viewport },
			yaw,
			pitch
		};
		dragMoved = false;
		hoverInfo = null;
		document.addEventListener('pointermove', onDocPointerMove);
		document.addEventListener('pointerup', onDocPointerUp);
	}

	function onDocPointerMove(e: PointerEvent) {
		if (!isDragging || !dragStart || !svgEl || !viewport) return;
		const dx = e.clientX - dragStart.clientX;
		const dy = e.clientY - dragStart.clientY;
		if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
			dragMoved = true;
			document.body.style.cursor = dragMode === 'rotate' ? 'move' : 'grabbing';
		}
		if (!dragMoved) return;

		if (dragMode === 'rotate') {
			yaw = dragStart.yaw + dx * YAW_PER_PX;
			pitch = Math.max(0, Math.min(PITCH_MAX, dragStart.pitch + dy * PITCH_PER_PX));
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		if (rect.width <= 0) return;
		const dxSvg = dx * (dragStart.vp.w / rect.width);
		const dySvg = dy * (dragStart.vp.h / rect.height);
		const newX = dragStart.vp.x - dxSvg;
		const newY = dragStart.vp.y - dySvg;
		viewport = clampViewportXY({ x: newX, y: newY, w: dragStart.vp.w, h: dragStart.vp.h });
	}

	function onDocPointerUp() {
		if (!isDragging) return;
		document.removeEventListener('pointermove', onDocPointerMove);
		document.removeEventListener('pointerup', onDocPointerUp);
		isDragging = false;
		document.body.style.cursor = '';
		dragStart = null;
		dragMoved = false;
	}

	let isResizing = false;
	let resizeStart: { clientY: number; height: number } | null = null;

	function onResizeDown(e: PointerEvent) {
		if (e.button !== 0 || !wrapperEl) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = wrapperEl.getBoundingClientRect();
		isResizing = true;
		resizeStart = { clientY: e.clientY, height: rect.height };
		document.body.style.cursor = 'nwse-resize';
		document.addEventListener('pointermove', onResizeMove);
		document.addEventListener('pointerup', onResizeUp);
	}

	function onResizeMove(e: PointerEvent) {
		if (!isResizing || !resizeStart) return;
		const dy = e.clientY - resizeStart.clientY;
		userHeight = Math.max(
			USER_HEIGHT_MIN,
			Math.min(USER_HEIGHT_MAX, resizeStart.height + dy)
		);
	}

	function onResizeUp() {
		if (!isResizing) return;
		document.removeEventListener('pointermove', onResizeMove);
		document.removeEventListener('pointerup', onResizeUp);
		isResizing = false;
		resizeStart = null;
		document.body.style.cursor = '';
	}

	let hoverInfo = $state<{ idx: number; cursorX: number; cursorY: number } | null>(null);

	$effect(() => {
		hoverDistM = hoverInfo ? slicedPoints[hoverInfo.idx]?.cumDistM ?? null : null;
	});

	function binAtDist(distM: number): GradeBin | null {
		for (const b of bins) {
			if (distM >= b.startM && distM <= b.endM) return b;
		}
		return null;
	}

	function onWrapperPointerMove(e: PointerEvent) {
		if (isDragging) return;
		if (!svgEl || !wrapperEl || !viewport || projectedPoints.length === 0) return;
		const svgRect = svgEl.getBoundingClientRect();
		const wrapRect = wrapperEl.getBoundingClientRect();
		if (svgRect.width <= 0) return;
		const relX = (e.clientX - svgRect.left) / svgRect.width;
		const relY = (e.clientY - svgRect.top) / svgRect.height;
		const svgX = viewport.x + relX * viewport.w;
		const svgY = viewport.y + relY * viewport.h;
		let bestIdx = -1;
		let bestDist = Infinity;
		for (let i = 0; i < projectedPoints.length; i++) {
			const [px, py] = projectedPoints[i];
			const d = Math.hypot(px - svgX, py - svgY);
			if (d < bestDist) {
				bestDist = d;
				bestIdx = i;
			}
		}
		const svgPerPx = viewport.w / svgRect.width;
		const thresholdSvg = HOVER_PX * svgPerPx;
		if (bestIdx >= 0 && bestDist <= thresholdSvg) {
			hoverInfo = {
				idx: bestIdx,
				cursorX: e.clientX - wrapRect.left,
				cursorY: e.clientY - wrapRect.top
			};
		} else {
			hoverInfo = null;
		}
	}

	function onWrapperPointerLeave() {
		if (!isDragging) hoverInfo = null;
	}

	onMount(() => {
		wrapperEl?.addEventListener('wheel', onWheel, { passive: false });
	});

	onDestroy(() => {
		wrapperEl?.removeEventListener('wheel', onWheel);
		document.removeEventListener('pointermove', onDocPointerMove);
		document.removeEventListener('pointerup', onDocPointerUp);
		document.removeEventListener('pointermove', onResizeMove);
		document.removeEventListener('pointerup', onResizeUp);
		if (vertHideTimer) clearTimeout(vertHideTimer);
		document.body.style.cursor = '';
	});

	function fmtKm(m: number): string {
		return `${(m / 1000).toFixed(2)} km`;
	}
	function fmtM(m: number): string {
		return `${Math.round(m)} m`;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={wrapperEl}
	bind:clientWidth={wrapperWidth}
	class="relative select-none bg-neutral-100"
	style:height={userHeight ? `${userHeight}px` : undefined}
	oncontextmenu={(e) => e.preventDefault()}
	onpointerdown={onPointerDown}
	onpointermove={onWrapperPointerMove}
	onpointerleave={onWrapperPointerLeave}
>
	<svg
		bind:this={svgEl}
		xmlns="http://www.w3.org/2000/svg"
		viewBox={viewBoxAttr}
		class="block w-full"
		class:h-auto={!userHeight}
		class:h-full={!!userHeight}
		preserveAspectRatio="xMidYMid meet"
		style:overflow="visible"
	>
		{#if showMap && blockFaces.length > 0 && tileOpacity > 0.01}
			{#each blockFaces as face, i (i)}
				<polygon
					points={face.points}
					fill="#f0e6d6"
					stroke="#d4c5ad"
					stroke-width="1"
					stroke-linejoin="round"
					opacity={tileOpacity}
					pointer-events="none"
				/>
			{/each}
		{/if}

		{#if showMap && tileImage && tileTransform && tileOpacity > 0.01}
			<image
				href={tileImage.url}
				width="1"
				height="1"
				preserveAspectRatio="none"
				transform="matrix({tileTransform.a} {tileTransform.b} {tileTransform.c} {tileTransform.d} {tileTransform.e} {tileTransform.f})"
				opacity={tileOpacity}
				pointer-events="none"
			/>
		{/if}

		{#if shadowPoints}
			<polyline
				points={shadowPoints}
				fill="none"
				stroke="#0f172a"
				stroke-opacity="0.16"
				stroke-width={STROKE * 1.6}
				stroke-linecap="round"
				stroke-linejoin="round"
				pointer-events="none"
			/>
		{/if}

		{#if showAnchorLines}
			{#each anchorLines as anchor, i (i)}
				<line
					x1={anchor.x1}
					y1={anchor.y1}
					x2={anchor.x2}
					y2={anchor.y2}
					stroke="#0f172a"
					stroke-opacity="0.12"
					stroke-width="1.5"
					stroke-dasharray="3 4"
					stroke-linecap="round"
					pointer-events="none"
				/>
			{/each}

			{#each boundaryAnchors as anchor, i (i)}
				<line
					x1={anchor.x1}
					y1={anchor.y1}
					x2={anchor.x2}
					y2={anchor.y2}
					stroke={anchor.color}
					stroke-opacity="0.65"
					stroke-width="2.5"
					stroke-dasharray="5 5"
					stroke-linecap="round"
					pointer-events="none"
				/>
			{/each}
		{/if}

		{#each polylines as line, i (i)}
			<polyline
				points={line.points}
				fill="none"
				stroke={line.color}
				stroke-width={STROKE}
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		{/each}

		{#if externalHoverPolyline}
			<polyline
				points={externalHoverPolyline}
				fill="none"
				stroke="#ffffff"
				stroke-opacity="0.55"
				stroke-width={STROKE * 2.2}
				stroke-linecap="round"
				stroke-linejoin="round"
				pointer-events="none"
			/>
		{/if}

		{#if startEnd}
			<circle
				cx={startEnd.a[0]}
				cy={startEnd.a[1]}
				r={STROKE * 1.6}
				fill="#10b981"
				stroke="#ffffff"
				stroke-width="3"
			/>
			<circle
				cx={startEnd.b[0]}
				cy={startEnd.b[1]}
				r={STROKE * 1.6}
				fill="#dc2626"
				stroke="#ffffff"
				stroke-width="3"
			/>
		{/if}

		{#if hoverInfo && projectedPoints[hoverInfo.idx]}
			{@const [hx, hy] = projectedPoints[hoverInfo.idx]}
			<circle
				cx={hx}
				cy={hy}
				r={STROKE * 1.4}
				fill="#111827"
				stroke="#ffffff"
				stroke-width="2"
				pointer-events="none"
			/>
		{/if}
	</svg>

	<div
		class="pointer-events-none absolute left-2 top-2 z-30 rounded-md bg-white/90 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-600 shadow-sm"
	>
		Topo
	</div>

	{#if isViewModified}
		<button
			type="button"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={resetView}
			class="absolute right-2 top-2 z-30 rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-neutral-600 shadow-sm hover:bg-white hover:text-neutral-900"
			aria-label="Reset view"
		>
			Reset view
		</button>
	{/if}

	<div
		onpointerdown={(e) => e.stopPropagation()}
		class="absolute bottom-2 left-2 z-30 flex items-center gap-0.5 rounded-md bg-white/90 px-1 py-0.5 shadow-sm"
	>
		<button
			type="button"
			onclick={() => (showMap = !showMap)}
			class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {showMap
				? 'text-neutral-800'
				: 'text-neutral-300'}"
			aria-label="Toggle map"
			aria-pressed={showMap}
			title={showMap ? 'Hide map' : 'Show map'}
		>
			<svg
				viewBox="0 0 24 24"
				class="h-4 w-4"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" />
				<line x1="9" y1="3" x2="9" y2="18" />
				<line x1="15" y1="6" x2="15" y2="21" />
			</svg>
		</button>
	</div>

	<div
		onpointerdown={(e) => e.stopPropagation()}
		class="absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-md bg-white/90 px-1 py-0.5 shadow-sm"
	>
		{#if is3D}
			<button
				type="button"
				onclick={() => (showAnchorLines = !showAnchorLines)}
				class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {showAnchorLines
					? 'text-neutral-800'
					: 'text-neutral-300'}"
				aria-label="Toggle anchor lines"
				aria-pressed={showAnchorLines}
				title={showAnchorLines ? 'Hide anchor lines' : 'Show anchor lines'}
			>
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
				>
					<circle cx="12" cy="6.5" r="2.6" fill="currentColor" stroke="none" />
					<line x1="12" y1="9.5" x2="12" y2="20" stroke-dasharray="2.4 2" />
				</svg>
			</button>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative"
				onpointerenter={openVert}
				onpointerleave={closeVert}
			>
				<button
					type="button"
					class="flex h-7 w-7 items-center justify-center rounded text-[10px] font-semibold tabular-nums text-neutral-800 hover:bg-neutral-100"
					aria-label="Vertical exaggeration"
					title="Vertical exaggeration"
				>
					{zExaggeration % 1 === 0 ? `${zExaggeration}×` : `${zExaggeration.toFixed(1)}×`}
				</button>
				{#if showVertPopover}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onpointerenter={openVert}
						onpointerleave={closeVert}
						class="absolute bottom-full right-0 mb-1 flex justify-center rounded-md bg-white px-2 py-2 shadow-lg ring-1 ring-neutral-200"
					>
						<input
							type="range"
							min="1"
							max="10"
							step="0.5"
							bind:value={zExaggeration}
							style="writing-mode: vertical-lr; direction: rtl;"
							class="h-28 w-4 accent-neutral-900"
							aria-label="Vertical exaggeration"
						/>
					</div>
				{/if}
			</div>
		{/if}
		<button
			type="button"
			onclick={toggle3D}
			class="flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold tabular-nums text-neutral-800 hover:bg-neutral-100"
			aria-label={is3D ? 'Switch to 2D' : 'Switch to 3D'}
			title={is3D ? 'Switch to 2D' : 'Switch to 3D'}
		>
			{is3D ? '3D' : '2D'}
		</button>
	</div>

	{#if hoverInfo && slicedPoints[hoverInfo.idx]}
		{@const p = slicedPoints[hoverInfo.idx]}
		{@const bin = binAtDist(p.cumDistM)}
		{@const distAlong = p.cumDistM - startDistM}
		<div
			class="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-1.5 whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
			style:left="{hoverInfo.cursorX}px"
			style:top="{hoverInfo.cursorY - 12}px"
		>
			<span class="tabular-nums">{fmtKm(distAlong)}</span>
			<span class="text-neutral-500">·</span>
			<span class="tabular-nums">{fmtM(p.ele)}</span>
			{#if bin}
				<span class="text-neutral-500">·</span>
				<span class="flex items-center gap-1">
					<span
						class="inline-block h-2 w-2 rounded-full"
						style:background-color={gradeColor(bin.grade)}
					></span>
					<span class="tabular-nums">{bin.grade.toFixed(1)}%</span>
				</span>
			{/if}
		</div>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		role="separator"
		aria-label="Resize map"
		onpointerdown={onResizeDown}
		class="absolute bottom-0 right-0 z-30 h-4 w-4 cursor-nwse-resize text-neutral-500 hover:text-neutral-800"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 16 16"
			class="h-full w-full"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
		>
			<line x1="14" y1="6" x2="6" y2="14" />
			<line x1="14" y1="11" x2="11" y2="14" />
		</svg>
	</div>
</div>
