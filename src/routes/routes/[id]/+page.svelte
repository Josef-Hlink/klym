<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import RouteMap from '$lib/components/RouteMap.svelte';
	import ElevationChart from '$lib/components/ElevationChart.svelte';
	import { computeCropStats, gradeColor } from '$lib/elevation.js';
	import type { PageProps } from './$types.js';

	let { data, form }: PageProps = $props();
	const route = $derived(data.route);
	const segments = $derived(data.segments);

	let hoverDistM = $state<number | null>(null);
	let markerA = $state<number | null>(null);
	let markerB = $state<number | null>(null);

	let savingMode = $state(false);
	let saveName = $state('');
	let saving = $state(false);
	let deletingId = $state<string | null>(null);

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

	function applySegment(startDistM: number, endDistM: number) {
		markerA = startDistM;
		markerB = endDistM;
	}

	function openSave() {
		saveName = '';
		savingMode = true;
	}

	function cancelSave() {
		savingMode = false;
		saveName = '';
	}

	function fmtKm(m: number): string {
		return `${(m / 1000).toFixed(2)} km`;
	}
	function fmtM(m: number): string {
		return `${Math.round(m)} m`;
	}
</script>

<svelte:head>
	<title>{route.name} · klym</title>
</svelte:head>

<main class="mx-auto max-w-5xl px-6 py-10">
	<a href="/" class="text-sm text-neutral-500 hover:text-neutral-900">← All routes</a>
	<header class="mt-4 mb-6 flex items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{route.name}</h1>
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
			{markerA}
			{markerB}
			onPlaceMarker={placeMarker}
			onRemoveMarker={removeMarker}
		/>

		<div class="rounded-lg border border-neutral-200 bg-white p-3 pt-2">
			<div class="mb-1 flex items-center justify-between px-1 text-xs">
				<span class="font-medium uppercase tracking-wide text-neutral-500">
					Elevation
				</span>
				<span class="text-[11px] text-neutral-400">
					click outside to set A / B · drag chips to adjust
				</span>
			</div>
			<ElevationChart
				points={route.points}
				bind:hoverDistM
				{markerA}
				{markerB}
				onPlaceMarker={placeMarker}
				onRemoveMarker={removeMarker}
				onMoveMarker={moveMarker}
			/>
		</div>

		{#if cropStats}
			<div class="rounded-lg border border-neutral-200 bg-white p-4">
				<h3 class="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
					Selection
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
			<h3 class="px-4 pt-4 pb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">
				Segments ({segments.length})
			</h3>
			{#if segments.length === 0}
				<p class="px-4 pb-4 text-sm text-neutral-500">
					No segments saved yet. Pick a crop with A and B, then hit “Save segment”.
				</p>
			{:else}
				<ul class="divide-y divide-neutral-200">
					{#each segmentsWithStats as seg (seg.id)}
						<li class="flex items-center gap-4 px-4 py-3">
							<button
								type="button"
								onclick={() => applySegment(seg.startDistM, seg.endDistM)}
								class="flex-1 text-left"
							>
								<div class="text-sm font-medium">{seg.name}</div>
								<div class="text-xs text-neutral-500">
									<code>{seg.id}</code> · {fmtKm(seg.startDistM)} → {fmtKm(seg.endDistM)}
								</div>
							</button>
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
							<form
								method="POST"
								action="?/deleteSegment"
								use:enhance={() => {
									deletingId = seg.id;
									return async ({ update }) => {
										await update({ reset: false });
										deletingId = null;
									};
								}}
							>
								<input type="hidden" name="segId" value={seg.id} />
								<button
									type="submit"
									disabled={deletingId === seg.id}
									class="text-xs text-neutral-500 hover:text-red-600 disabled:opacity-50"
									aria-label="Delete segment {seg.name}"
								>
									Delete
								</button>
							</form>
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

{#snippet iconSave()}
	<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="7 10 12 15 17 10" />
		<line x1="12" y1="15" x2="12" y2="3" />
	</svg>
{/snippet}

