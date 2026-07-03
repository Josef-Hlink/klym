<script lang="ts">
	import SegmentView from '$lib/components/SegmentView.svelte';
	import { slugify } from '$lib/slug.js';
	import type { PageProps } from './$types.js';

	let { data }: PageProps = $props();
</script>

<SegmentView
	route={data.route}
	name={data.name}
	startDistM={data.startM}
	endDistM={data.endM}
	exportBase="{data.route.id}-{slugify(data.name) || 'exploration'}"
/>
