<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import RouteMap from '$lib/components/RouteMap.svelte';
	import ElevationChart from '$lib/components/ElevationChart.svelte';
	import ActivityBadge from '$lib/components/ActivityBadge.svelte';
	import KlymBrand from '$lib/components/KlymBrand.svelte';
	import {
		DETECTION_PRESETS,
		categoryColor,
		detectClimbs,
		detectDescents,
		type DetectedClimb,
		type SensitivityPreset
	} from '$lib/climbs.js';
	import { computeCropStats, gradeColor } from '$lib/elevation.js';
	import { toGarminClimbInputs } from '$lib/garmin.js';
	import { fmtKm, fmtM } from '$lib/format.js';
	import type { PageProps } from './$types.js';

	let { data, form }: PageProps = $props();
	const route = $derived(data.route);
	const segments = $derived(data.segments);

	let hoverDistM = $state<number | null>(null);
	let markerA = $state<number | null>(null);
	let markerB = $state<number | null>(null);
	let hoveredSegmentId = $state<string | null>(null);

	let savingMode = $state(false);
	let saveName = $state('');
	let saving = $state(false);

	let openSegMenuId = $state<string | null>(null);
	let editingSegId = $state<string | null>(null);
	let editingSegName = $state('');
	let confirmingSegId = $state<string | null>(null);
	let adjusting = $state<{
		segId: string;
		segName: string;
		origA: number | null;
		origB: number | null;
	} | null>(null);
	let segError = $state<string | null>(null);

	// Climb/descent autodetection. Pure functions of the points, recomputed
	// only when the sensitivity preset changes; results are suggestions the
	// user can preview (hover), open directly (click — no saving needed) or
	// load into the markers to adjust (pencil).
	const SENSITIVITIES: SensitivityPreset[] = ['strict', 'balanced', 'sensitive'];
	type DetectionKind = 'c' | 'd';
	let sensitivity = $state<SensitivityPreset>('balanced');
	let climbsPanelOpen = $state(true);
	let showClimbBands = $state(true);
	let descentsPanelOpen = $state(false);
	let showDescentBands = $state(false);
	// Rows are addressed by key: "c3" = detectedClimbs[3], "c3:1" = its second
	// part (bridged climbs expose their halves via climb.parts), "d0" = the
	// first detected descent.
	let hoveredClimbKey = $state<string | null>(null);
	let expandedKeys = $state<string[]>([]);

	const detectedClimbs = $derived(detectClimbs(route.points, DETECTION_PRESETS[sensitivity]));
	const detectedDescents = $derived(detectDescents(route.points, DETECTION_PRESETS[sensitivity]));

	// Descent badges and chart bands stay uniformly gray for now (a dedicated
	// color scheme may come later).
	const DESCENT_GRAY = '#a3a3a3';

	function itemByKey(key: string | null): DetectedClimb | null {
		if (key == null) return null;
		const list = key[0] === 'd' ? detectedDescents : detectedClimbs;
		const [ti, pi] = key.slice(1).split(':');
		const top = list[Number(ti)];
		if (!top) return null;
		if (pi === undefined) return top;
		return top.parts?.[Number(pi)] ?? null;
	}

	// While a segment or detected-climb row is hovered, preview its A/B on the
	// map + chart. Interactions (click/drag) are disabled during preview so the
	// user doesn't accidentally edit their own markers. Suppressed while
	// adjusting since the markers are already loaded from the segment.
	const hoveredSegment = $derived.by(() =>
		hoveredSegmentId && !adjusting
			? (segments.find((s) => s.id === hoveredSegmentId) ?? null)
			: null
	);
	const hoveredClimb = $derived.by(() => (adjusting ? null : itemByKey(hoveredClimbKey)));
	// Hovering a part highlights the parent's band on the chart.
	const hoveredTop = $derived.by(() => {
		if (hoveredClimbKey == null) return null;
		return {
			kind: hoveredClimbKey[0] as DetectionKind,
			idx: Number(hoveredClimbKey.slice(1).split(':')[0])
		};
	});
	const previewRange = $derived.by(() => {
		if (hoveredSegment) return { a: hoveredSegment.startDistM, b: hoveredSegment.endDistM };
		if (hoveredClimb) return { a: hoveredClimb.startM, b: hoveredClimb.endM };
		return null;
	});
	const displayMarkerA = $derived(previewRange ? previewRange.a : markerA);
	const displayMarkerB = $derived(previewRange ? previewRange.b : markerB);
	const previewing = $derived(previewRange != null);

	function tint(hex: string, alpha: number): string {
		const r = parseInt(hex.slice(1, 3), 16);
		const g = parseInt(hex.slice(3, 5), 16);
		const b = parseInt(hex.slice(5, 7), 16);
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}

	const chartRegions = $derived.by(() => {
		const out: { startM: number; endM: number; color: string }[] = [];
		if (showClimbBands) {
			detectedClimbs.forEach((c, i) => {
				const hot = hoveredTop?.kind === 'c' && hoveredTop.idx === i;
				out.push({
					startM: c.startM,
					endM: c.endM,
					color: tint(categoryColor(c.category), hot ? 0.35 : 0.12)
				});
			});
		}
		if (showDescentBands) {
			detectedDescents.forEach((d, i) => {
				const hot = hoveredTop?.kind === 'd' && hoveredTop.idx === i;
				out.push({
					startM: d.startM,
					endM: d.endM,
					color: tint(DESCENT_GRAY, hot ? 0.4 : 0.15)
				});
			});
		}
		return out;
	});

	// Parts get a letter suffix: "Climb 5a (km 12.3)".
	function itemName(kind: DetectionKind, c: DetectedClimb, idx: number, partIdx?: number): string {
		const letter = partIdx == null ? '' : String.fromCharCode(97 + partIdx);
		const label = kind === 'd' ? 'Descent' : 'Climb';
		return `${label} ${idx + 1}${letter} (km ${(c.startM / 1000).toFixed(1)})`;
	}

	// Detected climbs/descents open as an ephemeral exploration — the full
	// segment view fed by query-param bounds, nothing saved.
	function exploreUrl(c: DetectedClimb, name: string): string {
		const q = new URLSearchParams({
			from: c.startM.toFixed(0),
			to: c.endM.toFixed(0),
			name
		});
		return `/routes/${route.id}/explore?${q}`;
	}

	let chartCardEl: HTMLDivElement | null = $state(null);
	// The chart is only sticky from sm up; on a phone, loading markers from a
	// row far down the list would happen off screen, so bring the chart back.
	function revealChart() {
		if (!chartCardEl || window.matchMedia('(min-width: 640px)').matches) return;
		const r = chartCardEl.getBoundingClientRect();
		if (r.top < 0 || r.bottom > window.innerHeight)
			chartCardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function selectClimb(c: DetectedClimb) {
		markerA = c.startM;
		markerB = c.endM;
		revealChart();
	}

	function setSensitivity(preset: SensitivityPreset) {
		sensitivity = preset;
		hoveredClimbKey = null;
		expandedKeys = [];
	}

	function toggleClimbsPanel() {
		climbsPanelOpen = !climbsPanelOpen;
		hoveredClimbKey = null;
	}

	function toggleDescentsPanel() {
		descentsPanelOpen = !descentsPanelOpen;
		hoveredClimbKey = null;
	}

	function toggleParts(key: string) {
		expandedKeys = expandedKeys.includes(key)
			? expandedKeys.filter((k) => k !== key)
			: [...expandedKeys, key];
	}

	const crop = $derived.by(() => {
		if (markerA == null || markerB == null) return null;
		if (markerB - markerA < 10) return null;
		return { startM: markerA, endM: markerB };
	});

	const cropStats = $derived.by(() => {
		if (!crop) return null;
		return computeCropStats(route.points, crop.startM, crop.endM, 500);
	});

	const segmentsWithStats = $derived(
		segments.map((seg) => ({
			...seg,
			stats: computeCropStats(route.points, seg.startDistM, seg.endDistM, seg.binSizeM)
		}))
	);

	const saveError = $derived(
		form && 'scope' in form && form.scope === 'save' && 'error' in form
			? (form.error as string)
			: null
	);

	// "Send to Garmin" pushes this route + the current detections into the
	// server's device slot (see src/lib/server/garmin.ts). Only rendered when
	// the browser holds the pairing cookie (data.garminEnabled).
	let garminSending = $state(false);
	let garminSent = $state(false);
	const garminClimbsJson = $derived(JSON.stringify(toGarminClimbInputs(detectedClimbs)));
	const garminError = $derived(
		form && 'scope' in form && form.scope === 'garmin' && 'error' in form
			? (form.error as string)
			: null
	);

	function placeMarker(distM: number) {
		if (markerA != null && markerB != null) {
			if (distM < markerA) markerA = distM;
			else if (distM > markerB) markerB = distM;
			else if (distM - markerA < markerB - distM) markerA = distM;
			else markerB = distM;
			return;
		}
		if (markerA != null) {
			if (distM < markerA) markerA = distM;
			else markerB = distM;
			return;
		}
		if (markerB != null) {
			if (distM > markerB) markerB = distM;
			else markerA = distM;
			return;
		}
		markerA = distM;
	}

	function removeMarker(which: 'A' | 'B') {
		if (which === 'A') markerA = null;
		else markerB = null;
	}

	function moveMarker(which: 'A' | 'B', distM: number) {
		if (which === 'A') {
			if (markerB != null) distM = Math.min(distM, markerB);
			markerA = distM;
		} else {
			if (markerA != null) distM = Math.max(distM, markerA);
			markerB = distM;
		}
	}

	function resetMarkers() {
		markerA = null;
		markerB = null;
	}

	function openSave() {
		saveName = '';
		savingMode = true;
	}

	function cancelSave() {
		savingMode = false;
		saveName = '';
	}

	function startSegRename(seg: { id: string; name: string }) {
		editingSegName = seg.name;
		editingSegId = seg.id;
		openSegMenuId = null;
		confirmingSegId = null;
	}
	function cancelSegRename() {
		editingSegId = null;
		editingSegName = '';
	}
	function startSegConfirmDelete(id: string) {
		confirmingSegId = id;
		openSegMenuId = null;
		editingSegId = null;
	}
	function cancelSegConfirmDelete() {
		confirmingSegId = null;
	}
	function startAdjust(seg: { id: string; name: string; startDistM: number; endDistM: number }) {
		adjusting = {
			segId: seg.id,
			segName: seg.name,
			origA: markerA,
			origB: markerB
		};
		markerA = seg.startDistM;
		markerB = seg.endDistM;
		revealChart();
		savingMode = false;
		saveName = '';
		openSegMenuId = null;
		editingSegId = null;
		confirmingSegId = null;
		hoveredSegmentId = null;
	}
	function cancelAdjust() {
		if (adjusting) {
			markerA = adjusting.origA;
			markerB = adjusting.origB;
		}
		adjusting = null;
	}

	$effect(() => {
		if (openSegMenuId === null) return;
		const handler = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t?.closest('[data-seg-menu]')) openSegMenuId = null;
		};
		document.addEventListener('pointerdown', handler);
		return () => document.removeEventListener('pointerdown', handler);
	});

	$effect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (editingSegId !== null) cancelSegRename();
			else if (confirmingSegId !== null) cancelSegConfirmDelete();
			else if (openSegMenuId !== null) openSegMenuId = null;
			else if (adjusting) cancelAdjust();
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	});

</script>

<svelte:head>
	<title>{route.name} · klym</title>
</svelte:head>

<main class="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
	<div class="flex items-center justify-between">
		<a href="/" class="text-sm text-neutral-500 hover:text-neutral-900">← All routes</a>
		<KlymBrand />
	</div>
	<!-- Phones stack the title over the stats; from sm they share a row. -->
	<header
		class="mt-4 mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4"
	>
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<h1 class="min-w-0 break-words text-xl font-semibold tracking-tight sm:text-2xl">
					{route.name}
				</h1>
				<ActivityBadge points={route.points} />
			</div>
			<p class="mt-1 break-all text-xs text-neutral-500"><code>{route.id}</code></p>
		</div>
		<div class="flex flex-row items-center justify-between gap-1.5 sm:flex-col sm:items-end">
			<dl class="flex gap-6 whitespace-nowrap sm:text-right">
				<div>
					<dt class="text-xs uppercase tracking-wide text-neutral-500">Distance</dt>
					<dd class="text-base font-medium">{fmtKm(route.totalDistM)}</dd>
				</div>
				<div>
					<dt class="text-xs uppercase tracking-wide text-neutral-500">Ascent</dt>
					<dd class="text-base font-medium">+{fmtM(route.totalAscentM)}</dd>
				</div>
			</dl>
			{#if data.garminEnabled}
				<form
					method="POST"
					action="?/sendToGarmin"
					use:enhance={() => {
						garminSending = true;
						return async ({ result, update }) => {
							garminSending = false;
							if (result.type === 'success') {
								garminSent = true;
								setTimeout(() => (garminSent = false), 2500);
							}
							await update();
						};
					}}
				>
					<input type="hidden" name="climbs" value={garminClimbsJson} />
					<button
						type="submit"
						disabled={garminSending}
						class="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-900 disabled:opacity-50"
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="h-3.5 w-3.5"
						>
							<path
								d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"
							/>
							<path d="m21.854 2.147-10.94 10.939" />
						</svg>
						{garminSending ? 'Sending…' : garminSent ? 'Sent ✓' : 'Send to Garmin'}
					</button>
				</form>
				{#if garminError}
					<p class="text-xs text-red-600">{garminError}</p>
				{/if}
			{/if}
		</div>
	</header>

	<section class="space-y-3">
		<RouteMap
			points={route.points}
			bounds={route.bounds}
			bind:hoverDistM
			markerA={displayMarkerA}
			markerB={displayMarkerB}
			onPlaceMarker={previewing ? undefined : placeMarker}
			onRemoveMarker={previewing ? undefined : removeMarker}
		/>

		<div
			bind:this={chartCardEl}
			class="scroll-mt-2 rounded-lg border border-neutral-200 bg-white p-2 pt-2 sm:sticky sm:top-0 sm:z-20 sm:p-3"
		>
			<div class="mb-1 flex items-baseline justify-between gap-3 px-1 text-xs">
				<span class="font-medium uppercase tracking-wide text-neutral-500">
					Elevation
				</span>
				<span class="text-right text-[11px] text-neutral-400 pointer-coarse:hidden">
					click the chart or map to set markers · drag chips to adjust
				</span>
				<span class="hidden text-right text-[11px] text-neutral-400 pointer-coarse:inline">
					tap to set markers · pinch to zoom
				</span>
			</div>
			<ElevationChart
				points={route.points}
				bind:hoverDistM
				markerA={displayMarkerA}
				markerB={displayMarkerB}
				onPlaceMarker={previewing ? undefined : placeMarker}
				onRemoveMarker={previewing ? undefined : removeMarker}
				onMoveMarker={previewing ? undefined : moveMarker}
				regions={chartRegions}
			/>
		</div>

		{#if cropStats}
			<div class="rounded-lg border border-neutral-200 bg-white p-4 {adjusting ? 'ring-2 ring-amber-300' : ''}">
				<h3 class="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
					{#if adjusting}
						Adjusting <span class="text-neutral-900">"{adjusting.segName}"</span>
					{:else}
						Selection
					{/if}
				</h3>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
					<div>
						<dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-500">
							{@render iconRoute()}
							Length
						</dt>
						<dd class="mt-1 text-lg font-medium">{fmtKm(cropStats.lengthM)}</dd>
					</div>
					<div>
						<dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-500">
							{@render iconTrendingUp()}
							Ascent
						</dt>
						<dd class="mt-1 text-lg font-medium">+{fmtM(cropStats.totalAscentM)}</dd>
					</div>
					<div>
						<dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-500">
							{@render iconPlusMinus()}
							Net gain
						</dt>
						<dd class="mt-1 text-lg font-medium">
							{cropStats.netGainM >= 0 ? '+' : ''}{fmtM(cropStats.netGainM)}
						</dd>
					</div>
					<div>
						<dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-500">
							{@render iconPercent()}
							Avg grade
						</dt>
						<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
							<span
								class="inline-block h-3 w-3 rounded"
								style:background-color={gradeColor(cropStats.avgGrade)}
							></span>
							{cropStats.avgGrade.toFixed(1)}%
						</dd>
					</div>
					<div>
						<dt class="flex items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-500">
							{@render iconFlame()}
							Max 500m
						</dt>
						<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
							<span
								class="inline-block h-3 w-3 rounded"
								style:background-color={gradeColor(cropStats.maxGrade)}
							></span>
							{cropStats.maxGrade.toFixed(1)}%
						</dd>
					</div>
					<div class="col-span-2 flex flex-wrap items-end justify-end gap-2 sm:col-span-1">
					{#if adjusting}
							<button
								type="button"
								onclick={cancelAdjust}
								class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
							>
								Cancel
							</button>
							<form
								method="POST"
								action="?/adjustSegment"
								use:enhance={() => {
									saving = true;
									segError = null;
									return async ({ result, update }) => {
										await update({ reset: false });
										saving = false;
										if (result.type === 'success') {
											cancelAdjust();
											await invalidateAll();
										} else if (result.type === 'failure') {
											segError =
												(result.data &&
													typeof result.data.error === 'string' &&
													result.data.error) ||
												'Adjust failed';
										}
									};
								}}
							>
								<input type="hidden" name="segId" value={adjusting.segId} />
								<input type="hidden" name="startDistM" value={crop?.startM ?? ''} />
								<input type="hidden" name="endDistM" value={crop?.endM ?? ''} />
								<button
									type="submit"
									disabled={saving || !crop}
									class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
								>
									{@render iconSave()}
									{saving ? 'Saving…' : 'Save changes'}
								</button>
							</form>
						{:else}
							<button
								type="button"
								onclick={resetMarkers}
								class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
							>
								{@render iconRotateCcw()}
								Reset
							</button>
							{#if !savingMode}
								<button
									type="button"
									onclick={openSave}
									class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
								>
									{@render iconSave()}
									Save segment
								</button>
							{/if}
						{/if}
					</div>
				</dl>

				{#if savingMode}
					<form
						method="POST"
						action="?/saveSegment"
						use:enhance={() => {
							saving = true;
							return async ({ result, update }) => {
								await update({ reset: false });
								saving = false;
								if (result.type === 'success') {
									savingMode = false;
									saveName = '';
									await invalidateAll();
								}
							};
						}}
						class="mt-4 border-t border-neutral-200 pt-4"
					>
						<div class="flex flex-wrap items-center gap-2">
							<!-- svelte-ignore a11y_autofocus -->
							<!-- text-base on a phone: iOS zooms the page into any input under 16px -->
							<input
								name="name"
								type="text"
								required
								autofocus
								autocomplete="off"
								bind:value={saveName}
								placeholder="Segment name (e.g. Alpe d'Huez climb)"
								class="min-w-0 basis-full rounded-md border border-neutral-300 px-3 py-1.5 text-base focus:border-neutral-900 focus:outline-none sm:flex-1 sm:basis-auto sm:text-sm"
							/>
							<span class="flex-1 sm:hidden"></span>
							<input type="hidden" name="startDistM" value={crop?.startM ?? ''} />
							<input type="hidden" name="endDistM" value={crop?.endM ?? ''} />
							<input type="hidden" name="binSizeM" value="500" />
							<button
								type="button"
								onclick={cancelSave}
								class="rounded-md px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={saving || !crop}
								class="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
							>
								{saving ? 'Saving…' : 'Save'}
							</button>
						</div>
						{#if saveError}
							<p class="mt-2 rounded bg-red-50 px-3 py-1.5 text-xs text-red-700">
								{saveError}
							</p>
						{/if}
					</form>
				{/if}
			</div>
		{:else if markerA != null || markerB != null}
			<div class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
				{#if markerA != null}
					<span class="font-medium">A</span> at {fmtKm(markerA)}.
				{:else if markerB != null}
					<span class="font-medium">B</span> at {fmtKm(markerB)}.
				{/if}
				<span class="pointer-coarse:hidden">Click</span><span class="hidden pointer-coarse:inline">Tap</span> to place the other.
				<button
					type="button"
					onclick={resetMarkers}
					class="ml-2 text-xs text-neutral-500 underline hover:text-neutral-900"
				>
					cancel
				</button>
			</div>
		{/if}

		<div class="rounded-lg border border-neutral-200 bg-white">
			<div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 {climbsPanelOpen ? 'pb-2' : 'pb-4'}">
				<h3 class="text-sm font-medium uppercase tracking-wide">
					<button
						type="button"
						aria-expanded={climbsPanelOpen}
						onclick={toggleClimbsPanel}
						class="flex items-center gap-1.5 text-neutral-500 hover:text-neutral-900"
					>
						{@render iconChevron(climbsPanelOpen)}
						{@render iconClimb()}
						Detected climbs ({detectedClimbs.length})
					</button>
				</h3>
				<div class="flex items-center gap-2">
				<div class="flex overflow-hidden rounded-md border border-neutral-300">
					{#each SENSITIVITIES as preset (preset)}
						<button
							type="button"
							onclick={() => setSensitivity(preset)}
							class="px-2 py-1 text-[11px] font-medium capitalize pointer-coarse:py-1.5 {sensitivity === preset
									? 'bg-neutral-900 text-white'
									: 'text-neutral-600 hover:bg-neutral-100'}"
							>
								{preset}
							</button>
						{/each}
					</div>
					{@render bandToggle(showClimbBands, () => (showClimbBands = !showClimbBands), 'climb')}
				</div>
			</div>
			{#if climbsPanelOpen}
			{#if detectedClimbs.length === 0}
				<p class="px-4 pb-4 text-sm text-neutral-500">
					No climbs detected at “{sensitivity}” sensitivity{sensitivity !== 'sensitive'
						? ' — try a more sensitive preset'
						: ''}.
				</p>
			{:else}
				{@render detectionList(detectedClimbs, 'c')}
			{/if}
			{/if}
		</div>

		<div class="rounded-lg border border-neutral-200 bg-white">
			<div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 {descentsPanelOpen ? 'pb-2' : 'pb-4'}">
				<h3 class="text-sm font-medium uppercase tracking-wide">
					<button
						type="button"
						aria-expanded={descentsPanelOpen}
						onclick={toggleDescentsPanel}
						class="flex items-center gap-1.5 text-neutral-500 hover:text-neutral-900"
					>
						{@render iconChevron(descentsPanelOpen)}
						{@render iconDescent()}
						Detected descents ({detectedDescents.length})
					</button>
				</h3>
				{@render bandToggle(showDescentBands, () => (showDescentBands = !showDescentBands), 'descent')}
			</div>
			{#if descentsPanelOpen}
			{#if detectedDescents.length === 0}
				<p class="px-4 pb-4 text-sm text-neutral-500">
					No descents detected at “{sensitivity}” sensitivity.
				</p>
			{:else}
				{@render detectionList(detectedDescents, 'd')}
			{/if}
			{/if}
		</div>

		<div class="rounded-lg border border-neutral-200 bg-white">
			<h3 class="px-4 pt-4 pb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">
				Segments ({segments.length})
			</h3>
			{#if segError}
				<p class="mx-4 mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{segError}</p>
			{/if}
			{#if segments.length === 0}
				<p class="px-4 pb-4 text-sm text-neutral-500">
					No segments saved yet. Pick a crop with A and B, then hit “Save segment”.
				</p>
			{:else}
				<ul class="divide-y divide-neutral-200">
					{#each segmentsWithStats as seg (seg.id)}
						<li
						class="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors sm:flex-nowrap {hoveredSegmentId ===
							seg.id
								? 'bg-neutral-50'
								: ''} {adjusting?.segId === seg.id ? 'bg-amber-50' : ''}"
							onpointerenter={(e) => {
								if (e.pointerType === 'mouse' && !adjusting) hoveredSegmentId = seg.id;
							}}
							onpointerleave={() => {
								if (hoveredSegmentId === seg.id) hoveredSegmentId = null;
							}}
						>
							{#if editingSegId === seg.id}
								<form
									method="POST"
									action="?/renameSegment"
									use:enhance={() => {
										segError = null;
										return async ({ result, update }) => {
											await update({ reset: false });
											if (result.type === 'success') {
												cancelSegRename();
											} else if (result.type === 'failure') {
												segError =
													(result.data &&
														typeof result.data.error === 'string' &&
														result.data.error) ||
													'Rename failed';
											}
										};
									}}
									class="flex min-w-0 flex-1 flex-wrap items-center gap-3 sm:flex-nowrap"
								>
									<input type="hidden" name="segId" value={seg.id} />
									<div class="min-w-0 basis-full sm:flex-1 sm:basis-auto">
										<!-- svelte-ignore a11y_autofocus -->
										<input
											name="name"
											type="text"
											autocomplete="off"
											bind:value={editingSegName}
											autofocus
											required
											class="block w-full rounded-md border border-neutral-300 px-2 py-1 text-base font-medium focus:border-neutral-900 focus:outline-none sm:text-sm"
										/>
										<div class="mt-1 text-xs text-neutral-500">
											<code>{seg.id}</code> · {fmtKm(seg.startDistM)} → {fmtKm(seg.endDistM)}
										</div>
									</div>
									<div class="flex items-center gap-1">
										<button
											type="submit"
											class="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700"
										>Save</button>
										<button
											type="button"
											onclick={cancelSegRename}
											class="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
										>Cancel</button>
									</div>
								</form>
							{:else}
								<a href="/routes/{route.id}/segments/{seg.id}" class="min-w-0 flex-1 text-left">
									<span class="absolute inset-0" aria-hidden="true"></span>
									<div class="flex flex-wrap items-center gap-2 text-sm font-medium">
										{seg.name}
										{#if adjusting?.segId === seg.id}
											<span class="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">adjusting</span>
										{/if}
									</div>
									<div class="break-words text-xs text-neutral-500">
										<code class="break-all">{seg.id}</code> · {fmtKm(seg.startDistM)} → {fmtKm(seg.endDistM)}
									</div>
								</a>
								<div
									class="order-last flex basis-full items-center justify-between gap-5 text-sm whitespace-nowrap tabular-nums sm:order-none sm:basis-auto sm:justify-start"
								>
									<div class="text-right">
										<div class="text-[10px] uppercase tracking-wide text-neutral-500">Length</div>
										<div class="font-medium">{fmtKm(seg.stats.lengthM)}</div>
									</div>
									<div class="text-right">
										<div class="text-[10px] uppercase tracking-wide text-neutral-500">Ascent</div>
										<div class="font-medium">+{fmtM(seg.stats.totalAscentM)}</div>
									</div>
									<div class="text-right">
										<div class="text-[10px] uppercase tracking-wide text-neutral-500">Avg</div>
										<div class="flex items-center justify-end gap-1.5 font-medium">
											<span
												class="inline-block h-2.5 w-2.5 rounded"
												style:background-color={gradeColor(seg.stats.avgGrade)}
											></span>
											{seg.stats.avgGrade.toFixed(1)}%
										</div>
									</div>
								</div>
								<div data-seg-menu class="relative z-10 flex items-center">
									{#if confirmingSegId === seg.id}
										<form
											method="POST"
											action="?/deleteSegment"
											use:enhance={() => {
												segError = null;
												return async ({ result, update }) => {
													await update({ reset: false });
													if (result.type === 'success') {
														cancelSegConfirmDelete();
													} else if (result.type === 'failure') {
														segError =
															(result.data &&
																typeof result.data.error === 'string' &&
																result.data.error) ||
															'Delete failed';
													}
												};
											}}
											class="flex items-center gap-1"
										>
											<input type="hidden" name="segId" value={seg.id} />
											<button
												type="submit"
												class="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
											>Delete</button>
											<button
												type="button"
												onclick={cancelSegConfirmDelete}
												class="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
											>Cancel</button>
										</form>
									{:else}
										<button
											type="button"
											aria-label="Open segment menu"
											aria-haspopup="menu"
											aria-expanded={openSegMenuId === seg.id}
											onclick={() =>
												(openSegMenuId = openSegMenuId === seg.id ? null : seg.id)}
											class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												viewBox="0 0 24 24"
												fill="currentColor"
												class="h-4 w-4"
												aria-hidden="true"
											>
												<circle cx="12" cy="5" r="1.6" />
												<circle cx="12" cy="12" r="1.6" />
												<circle cx="12" cy="19" r="1.6" />
											</svg>
										</button>
										{#if openSegMenuId === seg.id}
											<div
												role="menu"
												class="absolute right-0 top-full z-10 mt-1 w-32 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg"
											>
												<button
													type="button"
													role="menuitem"
													onclick={() => startSegRename(seg)}
													class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
												>Rename</button>
												<button
													type="button"
													role="menuitem"
													onclick={() => startAdjust(seg)}
													class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
												>Adjust start/end</button>
												<button
													type="button"
													role="menuitem"
													onclick={() => startSegConfirmDelete(seg.id)}
													class="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
												>Delete</button>
											</div>
										{/if}
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</section>
</main>

{#snippet iconRoute()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<circle cx="6" cy="19" r="3" />
		<path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
		<circle cx="18" cy="5" r="3" />
	</svg>
{/snippet}

{#snippet iconTrendingUp()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
		<polyline points="16 7 22 7 22 13" />
	</svg>
{/snippet}

{#snippet iconPlusMinus()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<line x1="8" y1="7" x2="16" y2="7" />
		<line x1="12" y1="3" x2="12" y2="11" />
		<line x1="8" y1="18" x2="16" y2="18" />
	</svg>
{/snippet}

{#snippet iconPercent()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<line x1="19" y1="5" x2="5" y2="19" />
		<circle cx="6.5" cy="6.5" r="2.5" />
		<circle cx="17.5" cy="17.5" r="2.5" />
	</svg>
{/snippet}

{#snippet iconFlame()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
	</svg>
{/snippet}

{#snippet iconRotateCcw()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
		<path d="M3 3v5h5" />
	</svg>
{/snippet}

{#snippet detectionList(list: DetectedClimb[], kind: DetectionKind)}
	<ul class="divide-y divide-neutral-200">
		{#each list as item, i (item.startM)}
			{@render detectionRow(item, kind, i, null)}
			{#if item.parts && expandedKeys.includes(`${kind}${i}`)}
				{#each item.parts as part, j (part.startM)}
					{@render detectionRow(part, kind, i, j)}
				{/each}
			{/if}
		{/each}
	</ul>
{/snippet}

<!-- One row per detected climb/descent (or part). The whole card navigates
     to the ephemeral explore view via a stretched link; the parts expander
     and the Adjust button float above it (relative z-10). -->
{#snippet detectionRow(c: DetectedClimb, kind: DetectionKind, i: number, partIdx: number | null)}
	{@const isPart = partIdx != null}
	{@const key = isPart ? `${kind}${i}:${partIdx}` : `${kind}${i}`}
	<li
	class="relative flex flex-wrap items-center gap-x-3 gap-y-2 transition-colors sm:flex-nowrap {isPart
		? 'py-2.5 pr-4 pl-8 sm:pl-12'
		: 'px-4 py-3'} {hoveredClimbKey === key ? 'bg-neutral-50' : isPart ? 'bg-neutral-50/40' : ''}"
		onpointerenter={(e) => {
			if (e.pointerType === 'mouse' && !adjusting) hoveredClimbKey = key;
		}}
		onpointerleave={() => {
			if (hoveredClimbKey === key) hoveredClimbKey = null;
		}}
	>
		<span
			class="flex shrink-0 items-center justify-center font-bold text-white {isPart
				? 'h-6 w-7 rounded text-[10px]'
				: 'h-8 w-9 rounded-md text-xs'}"
			style:background-color={kind === 'd' ? DESCENT_GRAY : categoryColor(c.category)}
			title={c.category
				? c.category === 'HC'
					? 'Hors catégorie'
					: `Category ${c.category}`
				: 'Uncategorized'}
		>
			{c.category ?? '·'}
		</span>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2 text-sm font-medium whitespace-nowrap">
				<a href={exploreUrl(c, itemName(kind, c, i, partIdx ?? undefined))} class="hover:underline">
					<span class="absolute inset-0" aria-hidden="true"></span>
					{kind === 'd' ? 'Descent' : 'Climb'}
					{i + 1}{partIdx == null ? '' : String.fromCharCode(97 + partIdx)}
				</a>
				{#if !isPart && c.parts}
					<button
						type="button"
						aria-expanded={expandedKeys.includes(key)}
						title="This {kind === 'd' ? 'descent' : 'climb'} was bridged across a gap — show its parts"
						onclick={() => toggleParts(key)}
						class="relative z-10 flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
					>
						{@render iconChevron(expandedKeys.includes(key))}
						{c.parts.length} parts
					</button>
				{/if}
			</div>
			<div class="text-xs text-neutral-500">
				{fmtKm(c.startM)} → {fmtKm(c.endM)}
				{#if kind === 'c'}
					{#if !isPart}· top {fmtM(c.topEleM)}{/if}
					· FIETS {c.fiets.toFixed(1)}
				{:else if !isPart}
					· bottom {fmtM(c.topEleM)}
				{/if}
			</div>
		</div>
		{@render climbStats(c, kind)}
		<button
			type="button"
			title="Load into the A/B markers to trim or extend"
			onclick={() => selectClimb(c)}
			aria-label="Adjust: load into the A/B markers"
			class="relative z-10 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900 pointer-coarse:py-2"
		>
			{@render iconPencil()}
			<span class="hidden sm:inline">Adjust</span>
		</button>
	</li>
{/snippet}

{#snippet climbStats(c: DetectedClimb, kind: DetectionKind)}
	<!-- On a phone the stats drop to their own row under the name (order-last
	     + full basis), spread across it; from sm they sit inline. -->
	<div
		class="order-last flex basis-full items-center justify-between gap-5 text-sm whitespace-nowrap tabular-nums sm:order-none sm:basis-auto sm:justify-start"
	>
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">Length</div>
			<div class="font-medium">{fmtKm(c.lengthM)}</div>
		</div>
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">
				{kind === 'd' ? 'Drop' : 'Gain'}
			</div>
			<div class="font-medium">{c.gainM >= 0 ? '+' : ''}{fmtM(c.gainM)}</div>
		</div>
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">Avg</div>
			<div class="flex items-center justify-end gap-1.5 font-medium">
				<span
					class="inline-block h-2.5 w-2.5 rounded"
					style:background-color={gradeColor(c.avgGrade)}
				></span>
				{c.avgGrade.toFixed(1)}%
			</div>
		</div>
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">Max</div>
			<div class="flex items-center justify-end gap-1.5 font-medium">
				<span
					class="inline-block h-2.5 w-2.5 rounded"
					style:background-color={gradeColor(c.maxGrade)}
				></span>
				{c.maxGrade.toFixed(1)}%
			</div>
		</div>
	</div>
{/snippet}

{#snippet bandToggle(on: boolean, toggle: () => void, what: string)}
	<button
		type="button"
		aria-pressed={on}
		title={on
			? `Hide ${what} bands on the elevation chart`
			: `Shade ${what} bands on the elevation chart`}
		onclick={toggle}
		class="flex h-[26px] w-7 items-center justify-center rounded-md border pointer-coarse:h-[30px] pointer-coarse:w-9 {on
			? 'border-neutral-900 bg-neutral-900 text-white'
			: 'border-neutral-300 text-neutral-500 hover:bg-neutral-100'}"
	>
		{@render iconEye()}
	</button>
{/snippet}

{#snippet iconChevron(open: boolean)}
	<svg class="h-3.5 w-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="9 6 15 12 9 18" />
	</svg>
{/snippet}

{#snippet iconClimb()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
		<polyline points="16 7 22 7 22 13" />
	</svg>
{/snippet}

{#snippet iconDescent()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
		<polyline points="16 17 22 17 22 11" />
	</svg>
{/snippet}

{#snippet iconPencil()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
	</svg>
{/snippet}

{#snippet iconEye()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
		<circle cx="12" cy="12" r="3" />
	</svg>
{/snippet}

{#snippet iconSave()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 10 12 15 17 10" />
		<line x1="12" y1="15" x2="12" y2="3" />
	</svg>
{/snippet}

