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

	const plotBounds = $derived.by(() => {
		plotVersion;
		if (!u) return null;
		const px = uPlot.pxRatio || 1;
		const left = u.bbox.left / px;
		const width = u.bbox.width / px;
		return { left, right: left + width };
	});

	function visiblePx(distM: number | null): number | null {
		const raw = distToPx(distM);
		if (raw == null || !plotBounds) return null;
		if (raw < plotBounds.left || raw > plotBounds.right) return null;
		return raw;
	}

	const markerAPx = $derived(visiblePx(markerA));
	const markerBPx = $derived(visiblePx(markerB));
	const cropRange = $derived.by(() => {
		if (markerA == null || markerB == null || !plotBounds) return null;
		const aRaw = distToPx(markerA);
		const bRaw = distToPx(markerB);
		if (aRaw == null || bRaw == null) return null;
		const lo = Math.min(aRaw, bRaw);
		const hi = Math.max(aRaw, bRaw);
		const left = Math.max(lo, plotBounds.left);
		const right = Math.min(hi, plotBounds.right);
		const width = right - left;
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
					values: (_u, splits) => {
						const gap =
							splits.length > 1 ? Math.abs(splits[1] - splits[0]) : 1;
						const decimals =
							gap >= 1 ? 0 : gap >= 0.1 ? 1 : gap >= 0.01 ? 2 : 3;
						return splits.map((v) => `${v.toFixed(decimals)} km`);
					}
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
		xRange = { min: 0, max: totalKm };

		ro = new ResizeObserver(() => {
			if (!u || !container) return;
			u.setSize({ width: container.clientWidth, height: CHART_H });
			plotVersion++;
		});
		ro.observe(container);

		// addEventListener with passive:false so preventDefault on wheel works
		// and zooming doesn't scroll the page.
		wrapperEl?.addEventListener('wheel', onWheel, { passive: false });
	});

	onDestroy(() => {
		ro?.disconnect();
		wrapperEl?.removeEventListener('wheel', onWheel);
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

	let xRange = $state<{ min: number; max: number } | null>(null);
	const totalKm = $derived(
		points.length > 0 ? points[points.length - 1].cumDistM / 1000 : 0
	);
	const isZoomed = $derived(
		xRange != null &&
			totalKm > 0 &&
			(xRange.min > 0.001 || xRange.max < totalKm - 0.001)
	);
	const ZOOM_FACTOR = 0.85;
	const MIN_VISIBLE_KM = 0.1;

	function setXRange(min: number, max: number) {
		if (!u) return;
		u.setScale('x', { min, max });
		xRange = { min, max };
		plotVersion++;
	}

	function resetZoom(e?: Event) {
		e?.stopPropagation();
		if (totalKm > 0) setXRange(0, totalKm);
	}

	function onWheel(e: WheelEvent) {
		if (!u || points.length === 0 || !container) return;
		e.preventDefault();
		const rect = container.getBoundingClientRect();
		const px = (uPlot.pxRatio || 1);
		const plotX = e.clientX - rect.left - u.bbox.left / px;
		const plotW = u.bbox.width / px;
		if (plotX < 0 || plotX > plotW) return;
		const cursorVal = u.posToVal(plotX, 'x');
		if (cursorVal == null || !Number.isFinite(cursorVal)) return;

		const min = u.scales.x.min ?? 0;
		const max = u.scales.x.max ?? totalKm;
		const width = max - min;
		const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
		const newWidth = Math.max(MIN_VISIBLE_KM, Math.min(totalKm, width * factor));
		const offset = width > 0 ? (cursorVal - min) / width : 0.5;
		let newMin = cursorVal - offset * newWidth;
		let newMax = newMin + newWidth;
		if (newMin < 0) {
			newMin = 0;
			newMax = newWidth;
		}
		if (newMax > totalKm) {
			newMax = totalKm;
			newMin = Math.max(0, totalKm - newWidth);
		}
		setXRange(newMin, newMax);
	}

	let isPanning = false;
	let panStartX = 0;
	let panStartRange: { min: number; max: number } | null = null;
	let panMoved = false;
	const PAN_THRESHOLD_PX = 4;

	function onDocPointerMove(e: PointerEvent) {
		if (!isPanning) return;
		const dx = e.clientX - panStartX;
		if (!panMoved && Math.abs(dx) > PAN_THRESHOLD_PX) {
			panMoved = true;
			if (isZoomed) document.body.style.cursor = 'grabbing';
		}
		if (!panMoved || !isZoomed || !u || !panStartRange) return;

		const px = uPlot.pxRatio || 1;
		const plotWPx = u.bbox.width / px;
		const range = panStartRange.max - panStartRange.min;
		const kmPerPx = range / plotWPx;
		const dKm = -dx * kmPerPx;
		let newMin = panStartRange.min + dKm;
		let newMax = panStartRange.max + dKm;
		if (newMin < 0) {
			newMax -= newMin;
			newMin = 0;
		}
		if (newMax > totalKm) {
			newMin -= newMax - totalKm;
			newMax = totalKm;
		}
		newMin = Math.max(0, Math.min(newMin, totalKm));
		newMax = Math.max(newMin, Math.min(newMax, totalKm));
		setXRange(newMin, newMax);
	}

	function onDocPointerUp() {
		if (!isPanning) return;
		document.removeEventListener('pointermove', onDocPointerMove);
		document.removeEventListener('pointerup', onDocPointerUp);
		isPanning = false;
		document.body.style.cursor = '';
		if (!panMoved && onPlaceMarker && u) {
			const idx = u.cursor.idx;
			if (idx != null && idx >= 0 && idx < points.length) {
				onPlaceMarker(points[idx].cumDistM);
			}
		}
		panStartRange = null;
		panMoved = false;
	}

	function handlePointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		if (!u) return;
		isPanning = true;
		panStartX = e.clientX;
		panStartRange = xRange ? { ...xRange } : null;
		panMoved = false;
		document.addEventListener('pointermove', onDocPointerMove);
		document.addEventListener('pointerup', onDocPointerUp);
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

	{#if isZoomed}
		<button
			type="button"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={resetZoom}
			class="absolute right-2 top-2 z-30 rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-neutral-600 shadow-sm hover:bg-white hover:text-neutral-900"
			aria-label="Reset zoom"
		>
			Reset zoom
		</button>
	{/if}

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
			aria-label="Marker A — drag to move, click to delete"
			title="Drag to move · click to delete"
			onpointerdown={(e) => onChipPointerDown(e, 'A')}
			onpointermove={(e) => onChipPointerMove(e, 'A')}
			onpointerup={(e) => onChipPointerUp(e, 'A')}
			class="absolute z-20 flex h-5 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-semibold leading-none text-white shadow-sm transition-colors hover:bg-emerald-700 {dragging ===
			'A'
				? 'cursor-grabbing'
				: 'cursor-grab'}"
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
			aria-label="Marker B — drag to move, click to delete"
			title="Drag to move · click to delete"
			onpointerdown={(e) => onChipPointerDown(e, 'B')}
			onpointermove={(e) => onChipPointerMove(e, 'B')}
			onpointerup={(e) => onChipPointerUp(e, 'B')}
			class="absolute z-20 flex h-5 w-7 -translate-x-1/2 items-center justify-center rounded-full bg-red-600 text-[11px] font-semibold leading-none text-white shadow-sm transition-colors hover:bg-red-700 {dragging ===
			'B'
				? 'cursor-grabbing'
				: 'cursor-grab'}"
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
