<script lang="ts">
	import { computeBins, findPointAtDistance, gradeColor } from '$lib/elevation.js';
	import type { RoutePoint } from '$lib/types.js';

	export type GradeLabelMode = 'percent' | 'number' | 'off';

	type Props = {
		points: RoutePoint[];
		startDistM: number;
		endDistM: number;
		binSizeM?: number;
		title?: string;
		subtitle?: string;
		labelMode?: GradeLabelMode;
		svgEl?: SVGSVGElement | null;
	};
	let {
		points,
		startDistM,
		endDistM,
		binSizeM = 500,
		title = 'klym',
		subtitle = '',
		labelMode = 'percent',
		svgEl = $bindable(null)
	}: Props = $props();

	function fmtGrade(grade: number): string {
		const n = grade.toFixed(0);
		return labelMode === 'percent' ? `${n}%` : n;
	}

	const W = 1600;
	const H = 800;
	const M = { top: 100, right: 90, bottom: 70, left: 60 };
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

	const bins = $derived(computeBins(points, startDistM, endDistM, binSizeM));

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
</script>

<svg
	bind:this={svgEl}
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 {W} {H}"
	class="block h-auto w-full"
	font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
>
	<rect width={W} height={H} fill="#f4f4f5" />

	<text x={M.left} y="38" font-size="26" font-weight="800" fill="#111">{title}</text>
	{#if subtitle}
		<text x={M.left} y="68" font-size="22" font-weight="600" fill="#a1a1aa">{subtitle}</text>
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
</svg>
