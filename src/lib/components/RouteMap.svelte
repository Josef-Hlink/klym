<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import maplibregl, { type Map as MLMap, type Marker } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { findPointAtDistance } from '$lib/elevation.js';
	import type { RouteBounds, RoutePoint } from '$lib/types.js';

	type Props = {
		points: RoutePoint[];
		bounds: RouteBounds;
		hoverDistM: number | null;
	};
	let { points, bounds, hoverDistM = $bindable(null) }: Props = $props();

	let container: HTMLDivElement | null = $state(null);
	let map: MLMap | null = null;
	let hoverMarker: Marker | null = null;
	let ready = $state(false);

	const OSM_STYLE: maplibregl.StyleSpecification = {
		version: 8,
		sources: {
			osm: {
				type: 'raster',
				tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
				tileSize: 256,
				attribution: '© OpenStreetMap contributors'
			}
		},
		layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
	};

	onMount(() => {
		if (!container) return;

		map = new maplibregl.Map({
			container,
			style: OSM_STYLE,
			bounds: [
				[bounds.minLon, bounds.minLat],
				[bounds.maxLon, bounds.maxLat]
			],
			fitBoundsOptions: { padding: 32 }
		});

		map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
		map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

		map.on('load', () => {
			if (!map) return;
			const coords = points.map((p) => [p.lon, p.lat]);

			map.addSource('track', {
				type: 'geojson',
				data: {
					type: 'Feature',
					geometry: { type: 'LineString', coordinates: coords },
					properties: {}
				}
			});
			map.addLayer({
				id: 'track-casing',
				type: 'line',
				source: 'track',
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: { 'line-color': '#ffffff', 'line-width': 7 }
			});
			map.addLayer({
				id: 'track',
				type: 'line',
				source: 'track',
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: { 'line-color': '#ff6b00', 'line-width': 4 }
			});

			const start = points[0];
			const end = points[points.length - 1];
			new maplibregl.Marker({ color: '#16a34a' })
				.setLngLat([start.lon, start.lat])
				.addTo(map);
			new maplibregl.Marker({ color: '#dc2626' })
				.setLngLat([end.lon, end.lat])
				.addTo(map);

			ready = true;
		});
	});

	onDestroy(() => {
		hoverMarker?.remove();
		map?.remove();
		map = null;
	});

	$effect(() => {
		if (!ready || !map) return;
		if (hoverDistM == null) {
			hoverMarker?.remove();
			hoverMarker = null;
			return;
		}
		const p = findPointAtDistance(points, hoverDistM);
		if (!hoverMarker) {
			const el = document.createElement('div');
			el.className =
				'h-3 w-3 rounded-full border-2 border-white bg-neutral-900 shadow ring-1 ring-black/20';
			hoverMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
		} else {
			hoverMarker.setLngLat([p.lon, p.lat]);
		}
	});
</script>

<div bind:this={container} class="h-[480px] w-full overflow-hidden rounded-lg border border-neutral-200"></div>
