<script lang="ts">
	import {
		computeBins,
		findPointAtDistance,
		gradeColor,
		type ColorTheme,
		type GradeBin
	} from '$lib/elevation.js';
	import KlymWordmarkGlyphs from './KlymWordmarkGlyphs.svelte';
	import { fmtDist } from '$lib/format.js';
	import type { RoutePoint } from '$lib/types.js';

	export type GradeLabelMode = 'percent' | 'number' | 'off';
	export type ProfileMode = 'raw' | 'straight' | 'smooth';

	type Props = {
		points: RoutePoint[];
		startDistM: number;
		endDistM: number;
		binSizeM?: number;
		bins?: GradeBin[];
		routeName?: string;
		sectionName?: string;
		labelMode?: GradeLabelMode;
		/**
		 * Section rendering: 'raw' follows the GPS trace, 'straight' snaps each
		 * section to a constant-grade ramp (the labelled grade), 'smooth' is the
		 * straight profile with softened junctions. Labels/stats are unaffected.
		 */
		profileMode?: ProfileMode;
		theme?: ColorTheme;
		externalHoverDistM?: number | null;
		hoverDistM?: number | null;
		svgEl?: SVGSVGElement | null;
	};
	let {
		points,
		startDistM,
		endDistM,
		binSizeM = 500,
		bins: binsProp,
		routeName = '',
		sectionName = '',
		labelMode = 'percent',
		profileMode = 'raw',
		theme = 'klym',
		externalHoverDistM = null,
		hoverDistM = $bindable(null),
		svgEl = $bindable(null)
	}: Props = $props();

	function fmtGrade(grade: number): string {
		const n = grade.toFixed(0);
		return labelMode === 'percent' ? `${n}%` : n;
	}

	const W = 1600;
	const H = 800;
	const M = { top: 142, right: 90, bottom: 70, left: 60 };
	const plotW = W - M.left - M.right;
	const plotH = H - M.top - M.bottom;
	const yBot = M.top + plotH;

	// Branding block: the mark with the coloured wordmark under it, sharing one
	// left edge and width; route/section names sit to their right on a common
	// left edge. The mark's content spans x 4→59, y 4→58 in its 64-unit viewBox;
	// the wordmark glyphs span x 3.84→185.66 with the baseline at y=0 and a
	// 46.47-unit ascender (see KlymWordmarkGlyphs.svelte).
	const BRAND_W = 60;
	const markScale = BRAND_W / 55;
	const markTop = 34;
	const markBottom = markTop + 54 * markScale;
	const wordScale = BRAND_W / 181.83;
	const wordBaseline = markBottom + 6 + 46.47 * wordScale;
	const labelX = M.left + BRAND_W + 14;

	const slicedPoints = $derived.by(() => {
		if (points.length === 0) return [];
		const a = findPointAtDistance(points, startDistM);
		const b = findPointAtDistance(points, endDistM);
		const out: { dist: number; ele: number }[] = [{ dist: a.cumDistM, ele: a.ele }];
		for (const p of points) {
			if (p.cumDistM <= a.cumDistM) continue;
			if (p.cumDistM >= b.cumDistM) break;
			out.push({ dist: p.cumDistM, ele: p.ele });
		}
		out.push({ dist: b.cumDistM, ele: b.ele });
		return out;
	});

	const bins = $derived(binsProp ?? computeBins(points, startDistM, endDistM, binSizeM));

	// Straightened elevation: inside each bin the profile is a straight ramp from
	// startEle to endEle, so a section labelled "3%" really rises at 3% the whole
	// way. Adjacent bins share their boundary elevation, so the ramps join up
	// continuously, and every vertex is a raw-curve sample — the straightened line
	// never leaves the raw elevation range, so the y-axis needn't rescale.
	function straightenedEleAt(distM: number): number {
		if (bins.length === 0) return 0;
		if (distM <= bins[0].startM) return bins[0].startEle;
		const last = bins[bins.length - 1];
		if (distM >= last.endM) return last.endEle;
		for (const bin of bins) {
			if (distM >= bin.startM && distM <= bin.endM) {
				const run = bin.endM - bin.startM;
				const t = run > 0 ? (distM - bin.startM) / run : 0;
				return bin.startEle + (bin.endEle - bin.startEle) * t;
			}
		}
		return last.endEle;
	}

	// 'smooth' mode = the straight profile with softened junctions. We densely
	// sample the straight ramps at uniform spacing, then run a short moving
	// average: straight runs stay straight and only the kinks round off, over a
	// near-constant on-screen width (uniform samples → the window is ~constant
	// pixels regardless of segment length). Purely cosmetic — labels/stats and
	// the grade per section are untouched.
	const SMOOTH_SAMPLES = 500;
	const SMOOTH_WINDOW = 9; // odd; corner reach ≈ SMOOTH_WINDOW/SMOOTH_SAMPLES of plotW

	const smoothedProfile = $derived.by<{ dist: number; ele: number }[]>(() => {
		if (profileMode !== 'smooth' || bins.length === 0) return [];
		const a = bins[0].startM;
		const b = bins[bins.length - 1].endM;
		const span = b - a;
		if (span <= 0) return [];
		const raw = new Array<number>(SMOOTH_SAMPLES + 1);
		for (let i = 0; i <= SMOOTH_SAMPLES; i++) {
			raw[i] = straightenedEleAt(a + (span * i) / SMOOTH_SAMPLES);
		}
		const half = (SMOOTH_WINDOW - 1) / 2;
		const out = new Array<{ dist: number; ele: number }>(SMOOTH_SAMPLES + 1);
		for (let i = 0; i <= SMOOTH_SAMPLES; i++) {
			let sum = 0;
			let cnt = 0;
			for (let k = -half; k <= half; k++) {
				const j = i + k;
				if (j < 0 || j > SMOOTH_SAMPLES) continue;
				sum += raw[j];
				cnt++;
			}
			out[i] = { dist: a + (span * i) / SMOOTH_SAMPLES, ele: sum / cnt };
		}
		// Pin the ends so the start/end elevation labels and end lines still land
		// exactly on the profile.
		out[0].ele = raw[0];
		out[SMOOTH_SAMPLES].ele = raw[SMOOTH_SAMPLES];
		return out;
	});

	function smoothEleAt(distM: number): number {
		const pts = smoothedProfile;
		if (pts.length === 0) return straightenedEleAt(distM);
		const a = pts[0].dist;
		const b = pts[pts.length - 1].dist;
		if (distM <= a) return pts[0].ele;
		if (distM >= b) return pts[pts.length - 1].ele;
		const n = pts.length - 1;
		const f = ((distM - a) / (b - a)) * n;
		const i = Math.floor(f);
		return pts[i].ele + (pts[i + 1].ele - pts[i].ele) * (f - i);
	}

	function eleAt(distM: number): number {
		if (profileMode === 'smooth') return smoothEleAt(distM);
		if (profileMode === 'straight') return straightenedEleAt(distM);
		return findPointAtDistance(points, distM).ele;
	}

	// Per-bin averages of optional activity streams. Each bin only carries a
	// metric if at least one point in its [startM, endM] range had it; we use
	// raw GPX points (not interpolated) so a sparse stream doesn't get smeared.
	type BinStreams = { hr?: number; power?: number; cad?: number; spd?: number };
	const binStreams = $derived.by<BinStreams[]>(() => {
		return bins.map((bin) => {
			let hrSum = 0, hrN = 0;
			let powSum = 0, powN = 0;
			let cadSum = 0, cadN = 0;
			let spdSum = 0, spdN = 0;
			for (const p of points) {
				if (p.cumDistM < bin.startM) continue;
				if (p.cumDistM > bin.endM) break;
				if (p.hr != null) { hrSum += p.hr; hrN++; }
				if (p.power != null) { powSum += p.power; powN++; }
				if (p.cad != null) { cadSum += p.cad; cadN++; }
				if (p.spd != null) { spdSum += p.spd; spdN++; }
			}
			const out: BinStreams = {};
			if (hrN > 0) out.hr = hrSum / hrN;
			if (powN > 0) out.power = powSum / powN;
			if (cadN > 0) out.cad = cadSum / cadN;
			if (spdN > 0) out.spd = spdSum / spdN;
			return out;
		});
	});

	const externalHoverIdx = $derived.by(() => {
		if (externalHoverDistM == null) return -1;
		const d = externalHoverDistM;
		for (let i = 0; i < bins.length; i++) {
			if (d >= bins[i].startM && d <= bins[i].endM) return i;
		}
		return -1;
	});

	const yRange = $derived.by(() => {
		if (slicedPoints.length === 0) return { min: 0, max: 100 };
		let minE = Infinity;
		let maxE = -Infinity;
		for (const p of slicedPoints) {
			if (p.ele < minE) minE = p.ele;
			if (p.ele > maxE) maxE = p.ele;
		}
		const pad = Math.max(20, (maxE - minE) * 0.06);
		return {
			min: Math.floor((minE - pad) / 50) * 50,
			max: Math.ceil((maxE + pad) / 50) * 50
		};
	});

	function xScale(distM: number): number {
		const total = endDistM - startDistM;
		if (total <= 0) return M.left;
		return M.left + ((distM - startDistM) / total) * plotW;
	}

	function yScale(ele: number): number {
		const { min, max } = yRange;
		const span = max - min || 1;
		return M.top + plotH - ((ele - min) / span) * plotH;
	}

	function pickTickStep(range: number): number {
		const steps = [20, 50, 100, 200, 250, 500, 1000];
		const target = range / 5;
		for (const s of steps) if (s >= target) return s;
		return 2000;
	}

	const yTicks = $derived.by(() => {
		const { min, max } = yRange;
		const step = pickTickStep(max - min);
		const out: number[] = [];
		for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
		return out;
	});

	// For each bin, build a polygon path that fills the area under the elevation
	// curve within [startM, endM]. Also track the highest elevation in the bin
	// so we can place the grade label near the visual top of the fill.
	const binAreas = $derived.by(() => {
		const yBot = M.top + plotH;
		const areas: {
			path: string;
			xCenter: number;
			yCenterCurve: number;
			yPeak: number;
			width: number;
			grade: number;
			startM: number;
			endM: number;
		}[] = [];
		for (const bin of bins) {
			// The top edge follows the raw curve, a single straight ramp
			// (start→end elevation), or the smoothed ramp clipped to this bin.
			const topPoints: { dist: number; ele: number }[] = [];
			if (profileMode === 'straight') {
				topPoints.push({ dist: bin.startM, ele: bin.startEle });
				topPoints.push({ dist: bin.endM, ele: bin.endEle });
			} else if (profileMode === 'smooth') {
				topPoints.push({ dist: bin.startM, ele: smoothEleAt(bin.startM) });
				for (const p of smoothedProfile) {
					if (p.dist <= bin.startM) continue;
					if (p.dist >= bin.endM) break;
					topPoints.push(p);
				}
				topPoints.push({ dist: bin.endM, ele: smoothEleAt(bin.endM) });
			} else {
				const a = findPointAtDistance(points, bin.startM);
				topPoints.push({ dist: a.cumDistM, ele: a.ele });
				for (const p of points) {
					if (p.cumDistM <= a.cumDistM) continue;
					if (p.cumDistM >= bin.endM) break;
					topPoints.push({ dist: p.cumDistM, ele: p.ele });
				}
				const b = findPointAtDistance(points, bin.endM);
				topPoints.push({ dist: b.cumDistM, ele: b.ele });
			}

			const xL = xScale(bin.startM);
			const xR = xScale(bin.endM);
			const parts: string[] = [`M${xL.toFixed(1)},${yBot.toFixed(1)}`];
			let yPeak = Infinity; // smallest y == highest point in viewBox space
			for (const p of topPoints) {
				const x = xScale(p.dist);
				const y = yScale(p.ele);
				if (y < yPeak) yPeak = y;
				parts.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
			}
			parts.push(`L${xR.toFixed(1)},${yBot.toFixed(1)} Z`);
			// Center reference: profile y at the bin's midpoint distance, so labels
			// track the center of the fill rather than the peak corner.
			const midDist = (bin.startM + bin.endM) / 2;
			areas.push({
				path: parts.join(' '),
				xCenter: (xL + xR) / 2,
				yCenterCurve: yScale(eleAt(midDist)),
				yPeak,
				width: xR - xL,
				grade: bin.grade,
				startM: bin.startM,
				endM: bin.endM
			});
		}
		return areas;
	});

	const elevPath = $derived.by(() => {
		if (profileMode === 'straight') {
			if (bins.length === 0) return '';
			const parts = [
				`M${xScale(bins[0].startM).toFixed(1)},${yScale(bins[0].startEle).toFixed(1)}`
			];
			for (const bin of bins) {
				parts.push(`L${xScale(bin.endM).toFixed(1)},${yScale(bin.endEle).toFixed(1)}`);
			}
			return parts.join(' ');
		}
		if (profileMode === 'smooth') {
			const pts = smoothedProfile;
			if (pts.length === 0) return '';
			const parts = [`M${xScale(pts[0].dist).toFixed(1)},${yScale(pts[0].ele).toFixed(1)}`];
			for (let i = 1; i < pts.length; i++) {
				parts.push(`L${xScale(pts[i].dist).toFixed(1)},${yScale(pts[i].ele).toFixed(1)}`);
			}
			return parts.join(' ');
		}
		if (slicedPoints.length === 0) return '';
		const parts: string[] = [];
		for (let i = 0; i < slicedPoints.length; i++) {
			const p = slicedPoints[i];
			const x = xScale(p.dist).toFixed(1);
			const y = yScale(p.ele).toFixed(1);
			parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
		}
		return parts.join(' ');
	});

	const endEle = $derived(slicedPoints[slicedPoints.length - 1]?.ele ?? 0);
	const startEle = $derived(slicedPoints[0]?.ele ?? 0);

	let wrapperEl: HTMLDivElement | null = $state(null);
	let wrapperW = $state(0);
	let tooltipW = $state(0);
	let tooltipH = $state(0);
	let hover = $state<{ idx: number; x: number; y: number } | null>(null);
	$effect(() => {
		// Drop stale hover when bins regenerate (e.g. dragging the ε slider).
		bins;
		hover = null;
	});
	$effect(() => {
		if (hover && bins[hover.idx]) {
			const b = bins[hover.idx];
			hoverDistM = (b.startM + b.endM) / 2;
		} else {
			hoverDistM = null;
		}
	});

	function updateHover(e: PointerEvent, idx: number) {
		if (!wrapperEl) return;
		const r = wrapperEl.getBoundingClientRect();
		hover = { idx, x: e.clientX - r.left, y: e.clientY - r.top };
	}
</script>

<div bind:this={wrapperEl} bind:clientWidth={wrapperW} class="relative">

<svg
	bind:this={svgEl}
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 {W} {H}"
	class="block h-auto w-full"
	font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
>
	<rect width={W} height={H} fill="#f4f4f5" />

	<!-- Branding block: inline copy of static/logo.svg (CSS classes don't
	     survive SVG export serialization, so everything is inline attributes)
	     with the wordmark glyphs underneath at the same width. -->
	<g transform="translate({M.left - 4 * markScale}, {markTop - 4 * markScale}) scale({markScale})">
		<polygon points="4,58 4,52 15,44 15,58" fill="#eab308" />
		<polygon points="15,58 15,44 26,34 26,58" fill="#f59e0b" />
		<polygon points="26,58 26,34 37,20 37,58" fill="#f97316" />
		<polygon points="37,58 37,20 48,4 48,58" fill="#dc2626" />
		<polygon points="48,58 48,4 59,58" fill="#7f1d1d" />
	</g>
	<g transform="translate({M.left - 3.84 * wordScale}, {wordBaseline}) scale({wordScale})">
		<KlymWordmarkGlyphs fill="#111" />
	</g>
	{#if sectionName}
		<text x={labelX} y={markBottom - 2} font-size="36" font-weight="800" fill="#111"
			>{sectionName}</text
		>
	{/if}
	{#if routeName}
		<text x={labelX} y={wordBaseline} font-size="18" font-weight="600" fill="#a1a1aa"
			>{routeName}</text
		>
	{/if}

	{#each yTicks as tick (tick)}
		{@const y = yScale(tick)}
		<line x1={M.left} x2={W - M.right} y1={y} y2={y} stroke="#e4e4e7" stroke-width="1" />
		<text
			x={W - M.right + 6}
			y={y}
			font-size="14"
			fill="#71717a"
			dominant-baseline="middle">{tick}m</text
		>
	{/each}

	{#each binAreas as area (area.startM)}
		<path d={area.path} fill={gradeColor(area.grade, theme)} />
	{/each}

	<!-- Start tick (0km boundary) -->
	<line
		x1={xScale(startDistM)}
		x2={xScale(startDistM)}
		y1={yBot}
		y2={yBot + 6}
		stroke="#52525b"
		stroke-width="1"
	/>

	{#each binAreas as area (area.startM)}
		{@const visibleHeight = yBot - area.yCenterCurve}


		{#if labelMode !== 'off'}
			{#if visibleHeight >= 48 && area.width >= 22}
				<text
					x={area.xCenter}
					y={area.yCenterCurve + Math.min(34, visibleHeight - 14)}
					font-size="18"
					font-weight="700"
					fill="#ffffff"
					text-anchor="middle"
					dominant-baseline="middle">{fmtGrade(area.grade)}</text
				>
			{:else if area.width >= 18}
				<text
					x={area.xCenter}
					y={area.yCenterCurve - 8}
					font-size="14"
					font-weight="700"
					fill="#52525b"
					text-anchor="middle">{fmtGrade(area.grade)}</text
				>
			{/if}
		{/if}
		<!-- Tick mark at bin end -->
		<line
			x1={xScale(area.endM)}
			x2={xScale(area.endM)}
			y1={yBot}
			y2={yBot + 6}
			stroke="#52525b"
			stroke-width="1"
		/>
		{@const labelX = xScale(area.endM)}
		{@const labelY = yBot + 24}
		<text
			x={labelX}
			y={labelY}
			font-size="13"
			fill="#52525b"
			text-anchor="end"
			transform="rotate(-30, {labelX.toFixed(1)}, {labelY.toFixed(1)})"
			>{fmtDist(area.endM - startDistM)}</text
		>
	{/each}

	<path
		d={elevPath}
		stroke="#111"
		stroke-width="3"
		fill="none"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>

	{#if binAreas.length > 0}
		{@const xL = xScale(startDistM)}
		<line
			x1={xL}
			x2={xL}
			y1={yScale(startEle)}
			y2={M.top + plotH}
			stroke="#111"
			stroke-width="2"
		/>
		<text
			x={xL - 4}
			y={yScale(startEle) - 6}
			font-size="14"
			font-weight="700"
			fill="#111"
			text-anchor="end">{Math.round(startEle)}m</text
		>

		{@const xR = xScale(endDistM)}
		<line
			x1={xR}
			x2={xR}
			y1={yScale(endEle)}
			y2={M.top + plotH}
			stroke="#111"
			stroke-width="2"
		/>
		<text
			x={xR + 4}
			y={yScale(endEle) - 6}
			font-size="14"
			font-weight="700"
			fill="#111"
			text-anchor="start">{Math.round(endEle)}m</text
		>
	{/if}

	{#if hover && binAreas[hover.idx]}
		<path
			d={binAreas[hover.idx].path}
			fill="#ffffff"
			fill-opacity="0.18"
			pointer-events="none"
		/>
	{:else if externalHoverIdx >= 0 && binAreas[externalHoverIdx]}
		<path
			d={binAreas[externalHoverIdx].path}
			fill="#ffffff"
			fill-opacity="0.18"
			pointer-events="none"
		/>
	{/if}

	{#if externalHoverDistM != null && externalHoverDistM >= startDistM && externalHoverDistM <= endDistM}
		<circle
			cx={xScale(externalHoverDistM)}
			cy={yScale(eleAt(externalHoverDistM))}
			r="8"
			fill="#111"
			stroke="#ffffff"
			stroke-width="2"
			pointer-events="none"
		/>
	{/if}

	{#each bins as bin, i (bin.startM)}
		{@const hx = xScale(bin.startM)}
		{@const hw = Math.max(0.5, xScale(bin.endM) - hx)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<rect
			x={hx}
			y={M.top}
			width={hw}
			height={plotH}
			fill="transparent"
			pointer-events="all"
			onpointerenter={(e) => updateHover(e, i)}
			onpointermove={(e) => updateHover(e, i)}
			onpointerleave={() => {
				if (hover?.idx === i) hover = null;
			}}
		/>
	{/each}
</svg>

{#if hover && bins[hover.idx]}
	{@const bin = bins[hover.idx]}
	{@const s = binStreams[hover.idx] ?? {}}
	{@const aKm = (bin.startM - startDistM) / 1000}
	{@const bKm = (bin.endM - startDistM) / 1000}
	{@const lenM = Math.round(bin.endM - bin.startM)}
	{@const gainM = Math.round(bin.endEle - bin.startEle)}
	{@const half = tooltipW / 2}
	{@const xClamped =
		wrapperW > 0 && tooltipW > 0
			? Math.max(half + 4, Math.min(wrapperW - half - 4, hover.x))
			: hover.x}
	<div
		bind:clientWidth={tooltipW}
		class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
		style:left="{xClamped}px"
		style:top="{hover.y - 12}px"
	>
		<div class="tabular-nums">
			{lenM} m <span class="text-neutral-400">({aKm.toFixed(1)} → {bKm.toFixed(1)} km)</span>
		</div>
		<div class="mt-0.5 flex items-center gap-1.5">
			<span
				class="inline-block h-2 w-2 rounded-full"
				style:background-color={gradeColor(bin.grade, theme)}
			></span>
			<span class="tabular-nums">
				{bin.grade.toFixed(1)}% <span class="text-neutral-400">({gainM >= 0 ? '+' : ''}{gainM} m)</span>
			</span>
		</div>
		{#if s.hr != null || s.power != null || s.spd != null || s.cad != null}
			<div class="mt-0.5 tabular-nums text-neutral-300">
				{#if s.hr != null}{Math.round(s.hr)} bpm{/if}{#if s.power != null}{s.hr != null ? ' · ' : ''}{Math.round(s.power)} W{/if}{#if s.spd != null}{s.hr != null || s.power != null ? ' · ' : ''}{(s.spd * 3.6).toFixed(1)} km/h{/if}{#if s.cad != null}{s.hr != null || s.power != null || s.spd != null ? ' · ' : ''}{Math.round(s.cad)} rpm{/if}
			</div>
		{/if}
	</div>
{:else if externalHoverIdx >= 0 && bins[externalHoverIdx] && binAreas[externalHoverIdx]}
	{@const bin = bins[externalHoverIdx]}
	{@const s = binStreams[externalHoverIdx] ?? {}}
	{@const area = binAreas[externalHoverIdx]}
	{@const aKm = (bin.startM - startDistM) / 1000}
	{@const bKm = (bin.endM - startDistM) / 1000}
	{@const lenM = Math.round(bin.endM - bin.startM)}
	{@const gainM = Math.round(bin.endEle - bin.startEle)}
	{@const cssScale = wrapperW > 0 ? wrapperW / W : 1}
	{@const xRaw = area.xCenter * cssScale}
	{@const yRaw = area.yPeak * cssScale}
	{@const half = tooltipW / 2}
	{@const xClamped =
		wrapperW > 0 && tooltipW > 0
			? Math.max(half + 4, Math.min(wrapperW - half - 4, xRaw))
			: xRaw}
	{@const yClamped = tooltipH > 0 ? Math.max(tooltipH + 4, yRaw - 8) : yRaw - 8}
	<div
		bind:clientWidth={tooltipW}
		bind:clientHeight={tooltipH}
		class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
		style:left="{xClamped}px"
		style:top="{yClamped}px"
	>
		<div class="tabular-nums">
			{lenM} m <span class="text-neutral-400">({aKm.toFixed(1)} → {bKm.toFixed(1)} km)</span>
		</div>
		<div class="mt-0.5 flex items-center gap-1.5">
			<span
				class="inline-block h-2 w-2 rounded-full"
				style:background-color={gradeColor(bin.grade, theme)}
			></span>
			<span class="tabular-nums">
				{bin.grade.toFixed(1)}% <span class="text-neutral-400">({gainM >= 0 ? '+' : ''}{gainM} m)</span>
			</span>
		</div>
		{#if s.hr != null || s.power != null || s.spd != null || s.cad != null}
			<div class="mt-0.5 tabular-nums text-neutral-300">
				{#if s.hr != null}{Math.round(s.hr)} bpm{/if}{#if s.power != null}{s.hr != null ? ' · ' : ''}{Math.round(s.power)} W{/if}{#if s.spd != null}{s.hr != null || s.power != null ? ' · ' : ''}{(s.spd * 3.6).toFixed(1)} km/h{/if}{#if s.cad != null}{s.hr != null || s.power != null || s.spd != null ? ' · ' : ''}{Math.round(s.cad)} rpm{/if}
			</div>
		{/if}
	</div>
{/if}
</div>
