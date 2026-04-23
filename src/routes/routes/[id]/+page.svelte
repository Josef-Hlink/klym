<script lang="ts">
	import RouteMap from '$lib/components/RouteMap.svelte';
	import ElevationChart from '$lib/components/ElevationChart.svelte';
	import type { PageProps } from './$types.js';

	let { data }: PageProps = $props();
	const route = $derived(data.route);

	let hoverDistM = $state<number | null>(null);

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
		/>

		<div class="rounded-lg border border-neutral-200 bg-white p-3 pt-2">
			<div class="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
				Elevation
			</div>
			<ElevationChart points={route.points} bind:hoverDistM />
		</div>
	</section>
</main>
