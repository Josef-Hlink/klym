<script lang="ts">
	import type { RoutePoint } from '$lib/types.js';

	type Props = { points: RoutePoint[] };
	let { points }: Props = $props();

	const isActivity = $derived(
		points.some((p) => p.hr != null || p.power != null || p.cad != null)
	);
</script>

{#if isActivity}
	<span class="group relative inline-flex">
		<span
			class="inline-flex cursor-help items-center gap-1 rounded-md border border-red-600 px-1.5 py-0.5 text-xs font-medium text-neutral-700"
		>
			<svg
				class="h-3 w-3 text-red-600"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path
					d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"
				/>
			</svg>
			Activity
		</span>
		<span
			role="tooltip"
			class="pointer-events-none absolute left-1/2 top-full z-30 mt-2 hidden w-max max-w-xs -translate-x-1/2 whitespace-normal rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg group-hover:block"
		>
			This route was detected as a recorded activity. Hovering the chart will
			now show HR, power, speed, and cadence per section.
		</span>
	</span>
{/if}
