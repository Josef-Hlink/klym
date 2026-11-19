<script lang="ts">
	import '../app.css';
	import HlinkRibbon from '$lib/components/HlinkRibbon.svelte';

	let { children } = $props();
</script>

{@render children()}

<HlinkRibbon park="touch" />
