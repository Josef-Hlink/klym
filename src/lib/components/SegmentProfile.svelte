<script lang="ts">
	import { computeBins, findPointAtDistance, gradeColor, type GradeBin } from '$lib/elevation.js';
	import type { RoutePoint } from '$lib/types.js';

	export type GradeLabelMode = 'percent' | 'number' | 'off';

	type Props = {
		points: RoutePoint[];
		startDistM: number;
		endDistM: number;
		binSizeM?: number;
		bins?: GradeBin[];
		title?: string;
		subtitle?: string;
		labelMode?: GradeLabelMode;
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
		title = 'klym',
		subtitle = '',
		labelMode = 'percent',
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
	const M = { top: 144, right: 90, bottom: 70, left: 60 };
	const plotW = W - M.left - M.right;
	const plotH = H - M.top - M.bottom;
	const yBot = M.top + plotH;

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
			width: number;
			grade: number;
			startM: number;
			endM: number;
		}[] = [];
		for (const bin of bins) {
			const binPoints: { dist: number; ele: number }[] = [];
			const a = findPointAtDistance(points, bin.startM);
			binPoints.push({ dist: a.cumDistM, ele: a.ele });
			for (const p of points) {
				if (p.cumDistM <= a.cumDistM) continue;
				if (p.cumDistM >= bin.endM) break;
				binPoints.push({ dist: p.cumDistM, ele: p.ele });
			}
			const b = findPointAtDistance(points, bin.endM);
			binPoints.push({ dist: b.cumDistM, ele: b.ele });

			const xL = xScale(bin.startM);
			const xR = xScale(bin.endM);
			const parts: string[] = [`M${xL.toFixed(1)},${yBot.toFixed(1)}`];
			for (const p of binPoints) {
				const x = xScale(p.dist);
				const y = yScale(p.ele);
				parts.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
			}
			parts.push(`L${xR.toFixed(1)},${yBot.toFixed(1)} Z`);
			// Center reference: curve y at bin's midpoint distance, so labels
			// track the center of the fill rather than the peak corner.
			const midDist = (bin.startM + bin.endM) / 2;
			const midPt = findPointAtDistance(points, midDist);
			areas.push({
				path: parts.join(' '),
				xCenter: (xL + xR) / 2,
				yCenterCurve: yScale(midPt.ele),
				width: xR - xL,
				grade: bin.grade,
				startM: bin.startM,
				endM: bin.endM
			});
		}
		return areas;
	});

	const elevPath = $derived.by(() => {
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

	function fmtDist(m: number): string {
		const km = m / 1000;
		return km >= 10 ? `${km.toFixed(0)}km` : `${km.toFixed(1)}km`;
	}

	const endEle = $derived(slicedPoints[slicedPoints.length - 1]?.ele ?? 0);
	const startEle = $derived(slicedPoints[0]?.ele ?? 0);

	let wrapperEl: HTMLDivElement | null = $state(null);
	let wrapperW = $state(0);
	let tooltipW = $state(0);
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

	<!-- Logo: scaled-down inline copy of static/logo.svg, baseline aligned
	     with the title text. -->
	<g transform="translate({M.left}, 53) scale(0.5)">
		<polygon points="4,58 4,52 15,44 15,58" fill="#eab308" />
		<polygon points="15,58 15,44 26,34 26,58" fill="#f59e0b" />
		<polygon points="26,58 26,34 37,20 37,58" fill="#f97316" />
		<polygon points="37,58 37,20 48,4 48,58" fill="#dc2626" />
		<polygon points="48,58 48,4 59,58" fill="#7f1d1d" />
	</g>
	<text x={M.left + 40} y="82" font-size="26" font-weight="800" fill="#111">{title}</text>
	{#if subtitle}
		<text x={M.left} y="112" font-size="22" font-weight="600" fill="#a1a1aa">{subtitle}</text>
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
		<path d={area.path} fill={gradeColor(area.grade)} />
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
				style:background-color={gradeColor(bin.grade)}
			></span>
			<span class="tabular-nums">
				{bin.grade.toFixed(1)}% <span class="text-neutral-400">({gainM >= 0 ? '+' : ''}{gainM} m)</span>
			</span>
		</div>
	</div>
{:else if externalHoverIdx >= 0 && bins[externalHoverIdx] && binAreas[externalHoverIdx]}
	{@const bin = bins[externalHoverIdx]}
	{@const area = binAreas[externalHoverIdx]}
	{@const aKm = (bin.startM - startDistM) / 1000}
	{@const bKm = (bin.endM - startDistM) / 1000}
	{@const lenM = Math.round(bin.endM - bin.startM)}
	{@const gainM = Math.round(bin.endEle - bin.startEle)}
	{@const cssScale = wrapperW > 0 ? wrapperW / W : 1}
	{@const xRaw = area.xCenter * cssScale}
	{@const yRaw = M.top * cssScale}
	{@const half = tooltipW / 2}
	{@const xClamped =
		wrapperW > 0 && tooltipW > 0
			? Math.max(half + 4, Math.min(wrapperW - half - 4, xRaw))
			: xRaw}
	<div
		bind:clientWidth={tooltipW}
		class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
		style:left="{xClamped}px"
		style:top="{yRaw - 8}px"
	>
		<div class="tabular-nums">
			{lenM} m <span class="text-neutral-400">({aKm.toFixed(1)} → {bKm.toFixed(1)} km)</span>
		</div>
		<div class="mt-0.5 flex items-center gap-1.5">
			<span
				class="inline-block h-2 w-2 rounded-full"
				style:background-color={gradeColor(bin.grade)}
			></span>
			<span class="tabular-nums">
				{bin.grade.toFixed(1)}% <span class="text-neutral-400">({gainM >= 0 ? '+' : ''}{gainM} m)</span>
			</span>
		</div>
	</div>
{/if}
</div>
