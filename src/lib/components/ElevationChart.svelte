<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import type { RoutePoint } from '$lib/types.js';
	import { bucketGradeAtDistance, findPointAtDistance, gradeColor } from '$lib/elevation.js';

	const Y_HEADROOM = 0.25;

	type Props = {
		points: RoutePoint[];
		hoverDistM: number | null;
		binSizeM?: number;
	};
	let { points, hoverDistM = $bindable(null), binSizeM = 500 }: Props = $props();

	let container: HTMLDivElement | null = $state(null);
	let u: uPlot | null = null;
	let ro: ResizeObserver | null = null;
	let cursorLeft = $state<number | null>(null);

	const hover = $derived.by(() => {
		if (hoverDistM == null) return null;
		const pt = findPointAtDistance(points, hoverDistM);
		const bucket = bucketGradeAtDistance(points, hoverDistM, binSizeM);
		return { pt, bucket };
	});

	onMount(() => {
		if (!container) return;

		const xs = points.map((p) => p.cumDistM / 1000);
		const ys = points.map((p) => p.ele);
		const width = container.clientWidth;
		const opts: uPlot.Options = {
			width,
			height: 200,
			padding: [8, 12, 0, 0],
			cursor: {
				drag: { x: false, y: false, setScale: false },
				points: { size: 8, fill: '#111', stroke: '#fff', width: 1.5 },
				move: (self, mouseLeft) => {
					if (mouseLeft < 0) return [mouseLeft, -10];
					const idx = self.posToIdx(mouseLeft);
					const val = idx != null ? self.data[1][idx] : null;
					if (val == null) return [mouseLeft, -10];
					return [mouseLeft, self.valToPos(val, 'y')];
				}
			},
			legend: { show: false },
			scales: {
				x: { time: false },
				y: {
					auto: true,
					range: (_self, dataMin, dataMax) => {
						const pad = (dataMax - dataMin) * Y_HEADROOM;
						return [dataMin, dataMax + pad];
					}
				}
			},
			axes: [
				{
					stroke: '#737373',
					grid: { stroke: '#f5f5f5' },
					ticks: { stroke: '#e5e5e5' },
					values: (_u, splits) => splits.map((v) => `${v.toFixed(0)} km`)
				},
				{
					stroke: '#737373',
					grid: { stroke: '#f5f5f5' },
					ticks: { stroke: '#e5e5e5' },
					values: (_u, splits) => splits.map((v) => `${v.toFixed(0)} m`)
				}
			],
			series: [
				{},
				{
					label: 'Elevation',
					stroke: '#404040',
					width: 1.5,
					fill: 'rgba(64, 64, 64, 0.15)'
				}
			],
			hooks: {
				setCursor: [
					(self) => {
						const idx = self.cursor.idx;
						if (idx == null || idx < 0 || idx >= points.length) {
							hoverDistM = null;
							cursorLeft = null;
							return;
						}
						hoverDistM = points[idx].cumDistM;
						cursorLeft = self.cursor.left ?? null;
					}
				]
			}
		};

		u = new uPlot(opts, [xs, ys], container);

		ro = new ResizeObserver(() => {
			if (!u || !container) return;
			u.setSize({ width: container.clientWidth, height: 200 });
		});
		ro.observe(container);
	});

	onDestroy(() => {
		ro?.disconnect();
		u?.destroy();
		u = null;
	});

	function fmtKm(m: number): string {
		return `${(m / 1000).toFixed(2)} km`;
	}
	function fmtM(m: number): string {
		return `${Math.round(m)} m`;
	}
</script>

<div class="relative w-full">
	<div bind:this={container} class="w-full"></div>
	{#if hover && cursorLeft != null && cursorLeft > 0}
		<div
			class="pointer-events-none absolute top-1 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs shadow-sm"
			style:left="{cursorLeft}px"
		>
			<span
				class="inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white"
				style:background-color={gradeColor(hover.bucket.grade)}
			>
				{hover.bucket.grade.toFixed(1)}%
			</span>
			<span class="tabular-nums text-neutral-700">
				{fmtKm(hover.pt.cumDistM)} · {fmtM(hover.pt.ele)}
			</span>
		</div>
	{/if}
</div>
