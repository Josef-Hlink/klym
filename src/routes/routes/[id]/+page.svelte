<script lang="ts">
	import type { PageProps } from './$types.js';

	let { data }: PageProps = $props();
	const route = $derived(data.route);

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

<main class="mx-auto max-w-5xl px-6 py-12">
	<a href="/" class="text-sm text-neutral-500 hover:text-neutral-900">← All routes</a>
	<header class="mt-4 mb-8">
		<h1 class="text-3xl font-semibold tracking-tight">{route.name}</h1>
		<p class="mt-1 text-xs text-neutral-500">
			<code>{route.id}</code>
		</p>
	</header>

	<dl class="grid grid-cols-2 gap-4 rounded-lg border border-neutral-200 bg-white p-5 text-sm sm:grid-cols-4">
		<div>
			<dt class="text-xs uppercase tracking-wide text-neutral-500">Distance</dt>
			<dd class="mt-1 text-lg font-medium">{fmtKm(route.totalDistM)}</dd>
		</div>
		<div>
			<dt class="text-xs uppercase tracking-wide text-neutral-500">Ascent</dt>
			<dd class="mt-1 text-lg font-medium">+{fmtM(route.totalAscentM)}</dd>
		</div>
		<div>
			<dt class="text-xs uppercase tracking-wide text-neutral-500">Points</dt>
			<dd class="mt-1 text-lg font-medium">{route.points.length}</dd>
		</div>
		<div>
			<dt class="text-xs uppercase tracking-wide text-neutral-500">Uploaded</dt>
			<dd class="mt-1 text-lg font-medium">
				{new Date(route.createdAt).toLocaleDateString()}
			</dd>
		</div>
	</dl>

	<section class="mt-8 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-10 text-center text-sm text-neutral-500">
		Map and elevation chart land in M3.
	</section>
</main>
