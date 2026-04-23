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
				<div class="mb-3 flex items-center justify-between">
					<h3 class="text-sm font-medium uppercase tracking-wide text-neutral-500">
						Selection
					</h3>
					<div class="flex items-center gap-3">
						<button
							type="button"
							onclick={resetMarkers}
							class="text-xs text-neutral-500 hover:text-neutral-900"
						>
							Reset
						</button>
						{#if !savingMode}
							<button
								type="button"
								onclick={openSave}
								class="inline-flex items-center rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
							>
								Save segment
							</button>
						{/if}
					</div>
				</div>
				<dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
					<div>
						<dt class="text-xs uppercase tracking-wide text-neutral-500">Length</dt>
						<dd class="mt-1 text-lg font-medium">{fmtKm(cropStats.lengthM)}</dd>
					</div>
					<div>
						<dt class="text-xs uppercase tracking-wide text-neutral-500">Net gain</dt>
						<dd class="mt-1 text-lg font-medium">
							{cropStats.netGainM >= 0 ? '+' : ''}{fmtM(cropStats.netGainM)}
						</dd>
					</div>
					<div>
						<dt class="text-xs uppercase tracking-wide text-neutral-500">Avg grade</dt>
						<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
							<span
								class="inline-block h-3 w-3 rounded"
								style:background-color={gradeColor(cropStats.avgGrade)}
							></span>
							{cropStats.avgGrade.toFixed(1)}%
						</dd>
					</div>
					<div>
						<dt class="text-xs uppercase tracking-wide text-neutral-500">Max 500m</dt>
						<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
							<span
								class="inline-block h-3 w-3 rounded"
								style:background-color={gradeColor(cropStats.maxGrade)}
							></span>
							{cropStats.maxGrade.toFixed(1)}%
						</dd>
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
					{#each segments as seg (seg.id)}
						<li class="flex items-center gap-3 px-4 py-3">
							<button
								type="button"
								onclick={() => applySegment(seg.startDistM, seg.endDistM)}
								class="flex-1 text-left"
							>
								<div class="text-sm font-medium">{seg.name}</div>
								<div class="text-xs text-neutral-500">
									<code>{seg.id}</code> · {fmtKm(seg.endDistM - seg.startDistM)} · {fmtKm(seg.startDistM)} → {fmtKm(seg.endDistM)}
								</div>
							</button>
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

