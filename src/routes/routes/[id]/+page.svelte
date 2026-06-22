<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import type { ActionResult } from '@sveltejs/kit';
	import RouteMap from '$lib/components/RouteMap.svelte';
	import ElevationChart from '$lib/components/ElevationChart.svelte';
	import ActivityBadge from '$lib/components/ActivityBadge.svelte';
	import {
		DETECTION_PRESETS,
		categoryColor,
		detectClimbs,
		type DetectedClimb,
		type SensitivityPreset
	} from '$lib/climbs.js';
	import { computeCropStats, gradeColor } from '$lib/elevation.js';
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

	// Climb autodetection. Pure function of the points, recomputed only when
	// the sensitivity preset changes; results are suggestions the user can
	// preview (hover), load into the markers (Select) or save directly.
	const SENSITIVITIES: SensitivityPreset[] = ['strict', 'balanced', 'sensitive'];
	let sensitivity = $state<SensitivityPreset>('balanced');
	let climbsPanelOpen = $state(true);
	let showClimbBands = $state(true);
	// Climb rows are addressed by key: "3" = detectedClimbs[3], "3:1" = its
	// second part (bridged climbs expose their halves via climb.parts).
	let hoveredClimbKey = $state<string | null>(null);
	let savingClimbKey = $state<string | null>(null);
	let expandedClimbs = $state<number[]>([]);
	let savingAllClimbs = $state(false);
	let climbError = $state<string | null>(null);

	const detectedClimbs = $derived(detectClimbs(route.points, DETECTION_PRESETS[sensitivity]));

	function climbByKey(key: string | null): DetectedClimb | null {
		if (key == null) return null;
		const [ti, pi] = key.split(':');
		const top = detectedClimbs[Number(ti)];
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
	const hoveredClimb = $derived.by(() => (adjusting ? null : climbByKey(hoveredClimbKey)));
	const hoveredTopIdx = $derived(
		hoveredClimbKey == null ? null : Number(hoveredClimbKey.split(':')[0])
	);
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

	const chartRegions = $derived(
		showClimbBands
			? detectedClimbs.map((c, i) => ({
					startM: c.startM,
					endM: c.endM,
					color: tint(categoryColor(c.category), i === hoveredTopIdx ? 0.35 : 0.12)
				}))
			: []
	);

	// A detected climb counts as saved when an existing segment matches its
	// bounds to within a meter (Select + manual save, or the quick-save below).
	function savedSegmentFor(c: DetectedClimb) {
		return segments.find(
			(s) => Math.abs(s.startDistM - c.startM) < 1 && Math.abs(s.endDistM - c.endM) < 1
		);
	}
	const unsavedClimbCount = $derived(detectedClimbs.filter((c) => !savedSegmentFor(c)).length);

	// Parts get a letter suffix: "Climb 5a (km 12.3)".
	function climbName(c: DetectedClimb, idx: number, partIdx?: number): string {
		const letter = partIdx == null ? '' : String.fromCharCode(97 + partIdx);
		return `Climb ${idx + 1}${letter} (km ${(c.startM / 1000).toFixed(1)})`;
	}

	function selectClimb(c: DetectedClimb) {
		markerA = c.startM;
		markerB = c.endM;
	}

	function setSensitivity(preset: SensitivityPreset) {
		sensitivity = preset;
		hoveredClimbKey = null;
		expandedClimbs = [];
		climbError = null;
	}

	function toggleClimbsPanel() {
		climbsPanelOpen = !climbsPanelOpen;
		hoveredClimbKey = null;
	}

	function toggleParts(idx: number) {
		expandedClimbs = expandedClimbs.includes(idx)
			? expandedClimbs.filter((i) => i !== idx)
			: [...expandedClimbs, idx];
	}

	async function postSaveClimb(c: DetectedClimb, name: string): Promise<boolean> {
		const body = new FormData();
		body.set('name', name);
		body.set('startDistM', String(c.startM));
		body.set('endDistM', String(c.endM));
		body.set('binSizeM', '500');
		let result: ActionResult;
		try {
			const res = await fetch('?/saveSegment', {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body
			});
			result = deserialize(await res.text());
		} catch {
			// Network drop or a non-action error body (e.g. a 500 HTML page that
			// deserialize can't parse). Surface it instead of leaving the row
			// stuck in its saving state with no feedback.
			climbError = 'Save failed';
			return false;
		}
		if (result.type === 'success') return true;
		climbError =
			result.type === 'failure' && typeof result.data?.error === 'string'
				? result.data.error
				: 'Save failed';
		return false;
	}

	async function saveClimb(c: DetectedClimb, key: string, name: string) {
		savingClimbKey = key;
		climbError = null;
		if (await postSaveClimb(c, name)) await invalidateAll();
		savingClimbKey = null;
	}

	// Keeps going past individual failures (e.g. a name conflict with an
	// earlier save) so one dupe doesn't strand the rest; first error wins.
	// Top-level climbs only — parts are saved one at a time, deliberately.
	async function saveAllClimbs() {
		savingAllClimbs = true;
		climbError = null;
		let firstError: string | null = null;
		for (let i = 0; i < detectedClimbs.length; i++) {
			const c = detectedClimbs[i];
			if (savedSegmentFor(c)) continue;
			if (!(await postSaveClimb(c, climbName(c, i)))) firstError ??= climbError;
		}
		climbError = firstError;
		await invalidateAll();
		savingAllClimbs = false;
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
		const handler = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t?.closest('[data-seg-menu]')) openSegMenuId = null;
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
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

<main class="mx-auto max-w-5xl px-6 py-10">
	<a href="/" class="text-sm text-neutral-500 hover:text-neutral-900">← All routes</a>
	<header class="mt-4 mb-6 flex items-end justify-between gap-4">
		<div>
			<div class="flex items-center gap-2">
				<h1 class="text-2xl font-semibold tracking-tight">{route.name}</h1>
				<ActivityBadge points={route.points} />
			</div>
			<p class="mt-1 text-xs text-neutral-500"><code>{route.id}</code></p>
		</div>
		<dl class="flex gap-6 text-right">
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Distance</dt>
				<dd class="text-base font-medium">{fmtKm(route.totalDistM)}</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Ascent</dt>
				<dd class="text-base font-medium">+{fmtM(route.totalAscentM)}</dd>
			</div>
		</dl>
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

		<div class="sticky top-0 z-20 rounded-lg border border-neutral-200 bg-white p-3 pt-2">
			<div class="mb-1 flex items-center justify-between px-1 text-xs">
				<span class="font-medium uppercase tracking-wide text-neutral-500">
					Elevation
				</span>
				<span class="text-[11px] text-neutral-400">
					click to set segment markers · drag chips to adjust
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
				<dl class="grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
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
					<div class="flex items-end justify-end gap-2">
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
						<div class="flex items-center gap-2">
							<!-- svelte-ignore a11y_autofocus -->
							<input
								name="name"
								type="text"
								required
								autofocus
								autocomplete="off"
								bind:value={saveName}
								placeholder="Segment name (e.g. Hohneck climb)"
								class="flex-1 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:border-neutral-900 focus:outline-none"
							/>
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
				Click to place the other.
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
						{@render iconMountain()}
						Detected climbs ({detectedClimbs.length})
					</button>
				</h3>
				{#if climbsPanelOpen}
				<div class="flex items-center gap-2">
					<div class="flex overflow-hidden rounded-md border border-neutral-300">
						{#each SENSITIVITIES as preset (preset)}
							<button
								type="button"
								onclick={() => setSensitivity(preset)}
								class="px-2 py-1 text-[11px] font-medium capitalize {sensitivity === preset
									? 'bg-neutral-900 text-white'
									: 'text-neutral-600 hover:bg-neutral-100'}"
							>
								{preset}
							</button>
						{/each}
					</div>
					<button
						type="button"
						aria-pressed={showClimbBands}
						title={showClimbBands
							? 'Hide climb bands on the elevation chart'
							: 'Shade climb bands on the elevation chart'}
						onclick={() => (showClimbBands = !showClimbBands)}
						class="flex h-[26px] w-7 items-center justify-center rounded-md border {showClimbBands
							? 'border-neutral-900 bg-neutral-900 text-white'
							: 'border-neutral-300 text-neutral-500 hover:bg-neutral-100'}"
					>
						{@render iconEye()}
					</button>
					{#if unsavedClimbCount > 0}
						<button
							type="button"
							disabled={savingAllClimbs || savingClimbKey != null}
							onclick={saveAllClimbs}
							class="rounded-md bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
						>
							{savingAllClimbs ? 'Saving…' : `Save all (${unsavedClimbCount})`}
						</button>
					{/if}
				</div>
				{/if}
			</div>
			{#if climbsPanelOpen}
			{#if climbError}
				<p class="mx-4 mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{climbError}</p>
			{/if}
			{#if detectedClimbs.length === 0}
				<p class="px-4 pb-4 text-sm text-neutral-500">
					No climbs detected at “{sensitivity}” sensitivity{sensitivity !== 'sensitive'
						? ' — try a more sensitive preset'
						: ''}.
				</p>
			{:else}
				<ul class="divide-y divide-neutral-200">
					{#each detectedClimbs as climb, i (climb.startM)}
						<li
							class="flex items-center gap-3 px-4 py-3 transition-colors {hoveredClimbKey === `${i}`
								? 'bg-neutral-50'
								: ''}"
							onpointerenter={(e) => {
								if (e.pointerType === 'mouse' && !adjusting) hoveredClimbKey = `${i}`;
							}}
							onpointerleave={() => {
								if (hoveredClimbKey === `${i}`) hoveredClimbKey = null;
							}}
						>
							<span
								class="flex h-8 w-9 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
								style:background-color={categoryColor(climb.category)}
								title={climb.category
									? climb.category === 'HC'
										? 'Hors catégorie'
										: `Category ${climb.category}`
									: 'Uncategorized'}
							>
								{climb.category ?? '·'}
							</span>
							<div class="flex-1">
								<div class="flex items-center gap-2 text-sm font-medium">
									Climb {i + 1}
									{#if climb.parts}
										<button
											type="button"
											aria-expanded={expandedClimbs.includes(i)}
											title="This climb was bridged across a dip — show its parts"
											onclick={() => toggleParts(i)}
											class="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
										>
											{@render iconChevron(expandedClimbs.includes(i))}
											{climb.parts.length} parts
										</button>
									{/if}
								</div>
								<div class="text-xs text-neutral-500">
									{fmtKm(climb.startM)} → {fmtKm(climb.endM)} · top {fmtM(climb.topEleM)} · FIETS
									{climb.fiets.toFixed(1)}
								</div>
							</div>
							{@render climbStats(climb)}
							{@render climbActions(climb, `${i}`, climbName(climb, i))}
						</li>
						{#if climb.parts && expandedClimbs.includes(i)}
							{#each climb.parts as part, j (part.startM)}
								{@const key = `${i}:${j}`}
								<li
									class="flex items-center gap-3 py-2.5 pr-4 pl-12 transition-colors {hoveredClimbKey ===
									key
										? 'bg-neutral-50'
										: 'bg-neutral-50/40'}"
									onpointerenter={(e) => {
										if (e.pointerType === 'mouse' && !adjusting) hoveredClimbKey = key;
									}}
									onpointerleave={() => {
										if (hoveredClimbKey === key) hoveredClimbKey = null;
									}}
								>
									<span
										class="flex h-6 w-7 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
										style:background-color={categoryColor(part.category)}
										title={part.category
											? part.category === 'HC'
												? 'Hors catégorie'
												: `Category ${part.category}`
											: 'Uncategorized'}
									>
										{part.category ?? '·'}
									</span>
									<div class="flex-1">
										<div class="text-sm font-medium">
											Climb {i + 1}{String.fromCharCode(97 + j)}
										</div>
										<div class="text-xs text-neutral-500">
											{fmtKm(part.startM)} → {fmtKm(part.endM)} · FIETS {part.fiets.toFixed(1)}
										</div>
									</div>
									{@render climbStats(part)}
									{@render climbActions(part, key, climbName(part, i, j))}
								</li>
							{/each}
						{/if}
					{/each}
				</ul>
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
							class="flex items-center gap-3 px-4 py-3 transition-colors {hoveredSegmentId ===
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
									class="flex flex-1 items-center gap-3"
								>
									<input type="hidden" name="segId" value={seg.id} />
									<div class="flex-1">
										<!-- svelte-ignore a11y_autofocus -->
										<input
											name="name"
											type="text"
											autocomplete="off"
											bind:value={editingSegName}
											autofocus
											required
											class="block w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-medium focus:border-neutral-900 focus:outline-none"
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
								<a href="/routes/{route.id}/segments/{seg.id}" class="flex-1 text-left">
									<div class="flex items-center gap-2 text-sm font-medium">
										{seg.name}
										{#if adjusting?.segId === seg.id}
											<span class="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">adjusting</span>
										{/if}
									</div>
									<div class="text-xs text-neutral-500">
										<code>{seg.id}</code> · {fmtKm(seg.startDistM)} → {fmtKm(seg.endDistM)}
									</div>
								</a>
								<div class="flex items-center gap-5 text-sm tabular-nums">
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
								<div data-seg-menu class="relative flex items-center">
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

{#snippet climbStats(c: DetectedClimb)}
	<div class="flex items-center gap-5 text-sm tabular-nums">
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">Length</div>
			<div class="font-medium">{fmtKm(c.lengthM)}</div>
		</div>
		<div class="text-right">
			<div class="text-[10px] uppercase tracking-wide text-neutral-500">Gain</div>
			<div class="font-medium">+{fmtM(c.gainM)}</div>
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

{#snippet climbActions(c: DetectedClimb, key: string, name: string)}
	{@const saved = savedSegmentFor(c)}
	<div class="flex items-center gap-1">
		<button
			type="button"
			title="Load this climb into the A/B markers"
			onclick={() => selectClimb(c)}
			class="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
		>
			Select
		</button>
		{#if saved}
			<a
				href="/routes/{route.id}/segments/{saved.id}"
				class="rounded-md px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
			>
				✓ Saved
			</a>
		{:else}
			<button
				type="button"
				disabled={savingClimbKey != null || savingAllClimbs}
				onclick={() => saveClimb(c, key, name)}
				class="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
			>
				{savingClimbKey === key ? 'Saving…' : 'Save'}
			</button>
		{/if}
	</div>
{/snippet}

{#snippet iconChevron(open: boolean)}
	<svg class="h-3.5 w-3.5 shrink-0 transition-transform {open ? 'rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<polyline points="9 6 15 12 9 18" />
	</svg>
{/snippet}

{#snippet iconMountain()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="m8 3 4 8 5-5 5 15H2L8 3z" />
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

