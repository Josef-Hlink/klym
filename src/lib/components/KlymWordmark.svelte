<script lang="ts">
	import KlymWordmarkGlyphs from './KlymWordmarkGlyphs.svelte';

	let { class: className = 'h-6 w-auto' }: { class?: string } = $props();
</script>

<!-- The coloured "klym." wordmark. Tight viewBox (ascender → descender) so
     a height class sizes it exactly. -->
<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="3.84 -46.47 181.83 59.91"
	fill="none"
	class={className}
	role="img"
	aria-label="klym"
>
	<KlymWordmarkGlyphs />
</svg>
