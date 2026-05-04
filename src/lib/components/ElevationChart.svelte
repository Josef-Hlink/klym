<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import type { RoutePoint } from '$lib/types.js';
	import { bucketGradeAtDistance, findPointAtDistance, gradeColor } from '$lib/elevation.js';

	const Y_HEADROOM = 0.25;
	const CHART_H = 200;
	const BADGE_GUTTER = 24;

	type Props = {
		points: RoutePoint[];
		hoverDistM: number | null;
		markerA?: number | null;
		markerB?: number | null;
		onPlaceMarker?: (distM: number) => void;
		onRemoveMarker?: (which: 'A' | 'B') => void;
		onMoveMarker?: (which: 'A' | 'B', distM: number) => void;
		binSizeM?: number;
	};
	let {
		points,
		hoverDistM = $bindable(null),
		markerA = null,
		markerB = null,
		onPlaceMarker,
		onRemoveMarker,
		onMoveMarker,
		binSizeM = 500
	}: Props = $props();

	let wrapperEl: HTMLDivElement | null = $state(null);
	let container: HTMLDivElement | null = $state(null);
	let u: uPlot | null = null;
	let ro: ResizeObserver | null = null;
	let cursorLeft = $state<number | null>(null);
	let plotVersion = $state(0);

	const hover = $derived.by(() => {
		if (hoverDistM == null) return null;
		const pt = findPointAtDistance(points, hoverDistM);
		const bucket = bucketGradeAtDistance(points, hoverDistM, binSizeM);
		return { pt, bucket };
	});

	function plotOffsetLeft(): number {
		plotVersion;
		if (!u) return 0;
		return u.bbox.left / (uPlot.pxRatio || 1);
	}

	function distToPx(distM: number | null): number | null {
		plotVersion;
		if (!u || distM == null) return null;
		const px = u.valToPos(distM / 1000, 'x');
		if (!Number.isFinite(px)) return null;
		return px + plotOffsetLeft();
	}

	const markerAPx = $derived(distToPx(markerA));
	const markerBPx = $derived(distToPx(markerB));
	const cropRange = $derived.by(() => {
		if (markerAPx == null || markerBPx == null) return null;
		const left = Math.min(markerAPx, markerBPx);
		const width = Math.abs(markerBPx - markerAPx);
		if (width < 1) return null;
		return { left, width };
	});


	onMount(() => {
		if (!container) return;

		const xs = points.map((p) => p.cumDistM / 1000);
		const ys = points.map((p) => p.ele);
		const width = container.clientWidth;
		const opts: uPlot.Options = {
			width,
			height: CHART_H,
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
					size: 60,
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
						const left = self.cursor.left ?? null;
						cursorLeft =
							left == null ? null : left + self.bbox.left / (uPlot.pxRatio || 1);
					}
				]
			}
		};

		u = new uPlot(opts, [xs, ys], container);
		plotVersion++;

		ro = new ResizeObserver(() => {
			if (!u || !container) return;
			u.setSize({ width: container.clientWidth, height: CHART_H });
			plotVersion++;
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

	let dragging = $state<'A' | 'B' | null>(null);
	let dragStartX = 0;
	let dragMoved = false;
	const DRAG_THRESHOLD_PX = 4;

	let armedChip = $state<'A' | 'B' | null>(null);
	const NUDGE_FINE_M = 5;
	const NUDGE_COARSE_M = 50;

	$effect(() => {
		if (armedChip == null || !onMoveMarker) return;
		const which = armedChip;
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			const current = which === 'A' ? markerA : markerB;
			if (current == null) return;
			e.preventDefault();
			const dir = e.key === 'ArrowLeft' ? -1 : 1;
			const step = e.shiftKey ? NUDGE_COARSE_M : NUDGE_FINE_M;
			const total = points[points.length - 1].cumDistM;
			const next = Math.max(0, Math.min(total, current + dir * step));
			onMoveMarker(which, next);
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	});

	function handlePointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		if (!u || !onPlaceMarker) return;
		const idx = u.cursor.idx;
		if (idx == null || idx < 0 || idx >= points.length) return;
		onPlaceMarker(points[idx].cumDistM);
	}

	function wrapXToDistM(wrapX: number): number | null {
		if (!u || !wrapperEl) return null;
		const plotX = wrapX - plotOffsetLeft();
		const val = u.posToVal(plotX, 'x');
		if (val == null || !Number.isFinite(val)) return null;
		const total = points[points.length - 1].cumDistM;
		return Math.max(0, Math.min(val * 1000, total));
	}

	function onChipPointerDown(e: PointerEvent, which: 'A' | 'B') {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		dragging = which;
		dragStartX = e.clientX;
		dragMoved = false;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		document.body.style.cursor = 'grabbing';
	}

	function onChipPointerMove(e: PointerEvent, which: 'A' | 'B') {
		if (dragging !== which || !wrapperEl) return;
		if (!dragMoved && Math.abs(e.clientX - dragStartX) > DRAG_THRESHOLD_PX) {
			dragMoved = true;
		}
		if (!dragMoved) return;
		const rect = wrapperEl.getBoundingClientRect();
		const wrapX = e.clientX - rect.left;
		const distM = wrapXToDistM(wrapX);
		if (distM != null) onMoveMarker?.(which, distM);
	}

	function onChipPointerUp(e: PointerEvent, which: 'A' | 'B') {
		if (dragging !== which) return;
		const target = e.currentTarget as HTMLElement;
		if (target.hasPointerCapture?.(e.pointerId)) {
			target.releasePointerCapture(e.pointerId);
		}
		document.body.style.cursor = '';
		dragging = null;
		if (!dragMoved) onRemoveMarker?.(which);
		dragMoved = false;
	}

</script>

<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
<div
	bind:this={wrapperEl}
	class="relative w-full select-none"
	style:padding-bottom="{BADGE_GUTTER}px"
	onpointerdown={handlePointerDown}
>
	<div bind:this={container} class="w-full cursor-crosshair"></div>

	{#if cropRange}
		<div
			class="pointer-events-none absolute bg-orange-200/35"
			style:left="{cropRange.left}px"
			style:width="{cropRange.width}px"
			style:top="0"
			style:height="{CHART_H}px"
		></div>
	{/if}

	{#if markerAPx != null}
		<div
			class="pointer-events-none absolute -translate-x-1/2 bg-emerald-600"
			style:left="{markerAPx}px"
			style:top="0"
			style:width="2px"
			style:height="{CHART_H + 12}px"
		></div>
		<button
			type="button"
			aria-label="Marker A — drag to move, hover and use ←/→ to nudge, click to delete"
			title="Drag · hover + ←/→ nudge (Shift = ±50 m) · click to delete"
			onpointerdown={(e) => onChipPointerDown(e, 'A')}
			onpointermove={(e) => onChipPointerMove(e, 'A')}
			onpointerup={(e) => onChipPointerUp(e, 'A')}
			onpointerenter={() => (armedChip = 'A')}
			onpointerleave={() => {
				if (armedChip === 'A') armedChip = null;
			}}
			class="absolute z-20 flex h-5 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-semibold leading-none text-white shadow-sm transition-colors hover:bg-emerald-700 {armedChip ===
			'A'
				? 'ring-2 ring-emerald-300'
				: ''} {dragging === 'A' ? 'cursor-grabbing' : 'cursor-grab'}"
			style:left="{markerAPx}px"
			style:top="{CHART_H - 8}px"
		>
			A
		</button>
	{/if}

	{#if markerBPx != null}
		<div
			class="pointer-events-none absolute -translate-x-1/2 bg-red-600"
			style:left="{markerBPx}px"
			style:top="0"
			style:width="2px"
			style:height="{CHART_H + 12}px"
		></div>
		<button
			type="button"
			aria-label="Marker B — drag to move, hover and use ←/→ to nudge, click to delete"
			title="Drag · hover + ←/→ nudge (Shift = ±50 m) · click to delete"
			onpointerdown={(e) => onChipPointerDown(e, 'B')}
			onpointermove={(e) => onChipPointerMove(e, 'B')}
			onpointerup={(e) => onChipPointerUp(e, 'B')}
			onpointerenter={() => (armedChip = 'B')}
			onpointerleave={() => {
				if (armedChip === 'B') armedChip = null;
			}}
			class="absolute z-20 flex h-5 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-red-600 text-[11px] font-semibold leading-none text-white shadow-sm transition-colors hover:bg-red-700 {armedChip ===
			'B'
				? 'ring-2 ring-red-300'
				: ''} {dragging === 'B' ? 'cursor-grabbing' : 'cursor-grab'}"
			style:left="{markerBPx}px"
			style:top="{CHART_H - 8}px"
		>
			B
		</button>
	{/if}

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
