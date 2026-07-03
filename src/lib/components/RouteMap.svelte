<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import maplibregl, { type Map as MLMap, type MapMouseEvent, type Marker } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { findPointAtDistance } from '$lib/elevation.js';
	import type { RouteBounds, RoutePoint } from '$lib/types.js';

	type Props = {
		points: RoutePoint[];
		bounds: RouteBounds;
		hoverDistM: number | null;
		markerA?: number | null;
		markerB?: number | null;
		onPlaceMarker?: (distM: number) => void;
		onRemoveMarker?: (which: 'A' | 'B') => void;
	};
	let {
		points,
		bounds,
		hoverDistM = $bindable(null),
		markerA = null,
		markerB = null,
		onPlaceMarker,
		onRemoveMarker: _onRemoveMarker
	}: Props = $props();

	let container: HTMLDivElement | null = $state(null);
	let map: MLMap | null = null;
	let hoverMarker: Marker | null = null;
	let markerAEl: Marker | null = null;
	let markerBEl: Marker | null = null;
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

	// Longitude deltas are scaled by cos(lat) so "nearest" matches what the
	// eye sees on the (north-up) mercator map, not nearest in raw degrees.
	function nearestPointDist(lng: number, lat: number): number {
		const cosLat = Math.cos((lat * Math.PI) / 180);
		let bestIdx = 0;
		let bestD = Infinity;
		for (let i = 0; i < points.length; i++) {
			const dLat = lat - points[i].lat;
			const dLng = (lng - points[i].lon) * cosLat;
			const d = dLat * dLat + dLng * dLng;
			if (d < bestD) {
				bestD = d;
				bestIdx = i;
			}
		}
		return points[bestIdx].cumDistM;
	}

	// Hovers and pin-drop clicks anywhere on the map snap to the track as long
	// as the nearest track point is within this many screen pixels.
	const SNAP_PX = 30;

	// Nearest track point to a mouse event, or null when it's further than
	// SNAP_PX on screen. Shared by the hover and click handlers.
	function snapToTrack(e: MapMouseEvent): number | null {
		if (!map) return null;
		const distM = nearestPointDist(e.lngLat.lng, e.lngLat.lat);
		const p = findPointAtDistance(points, distM);
		const proj = map.project([p.lon, p.lat]);
		const dx = proj.x - e.point.x;
		const dy = proj.y - e.point.y;
		return dx * dx + dy * dy <= SNAP_PX * SNAP_PX ? distM : null;
	}

	function cropCoords(startM: number, endM: number): [number, number][] {
		const out: [number, number][] = [];
		const a = findPointAtDistance(points, startM);
		out.push([a.lon, a.lat]);
		for (let i = a.idx; i < points.length; i++) {
			const p = points[i];
			if (p.cumDistM <= startM) continue;
			if (p.cumDistM >= endM) break;
			out.push([p.lon, p.lat]);
		}
		const b = findPointAtDistance(points, endM);
		out.push([b.lon, b.lat]);
		return out;
	}

	function makeLabelEl(label: string, bg: string): HTMLDivElement {
		const el = document.createElement('div');
		el.className =
			'flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[11px] font-semibold text-white shadow-md';
		el.style.backgroundColor = bg;
		el.textContent = label;
		return el;
	}

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
			map.addSource('track-crop', {
				type: 'geojson',
				data: {
					type: 'Feature',
					geometry: { type: 'LineString', coordinates: [] },
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
			map.addLayer({
				id: 'track-crop',
				type: 'line',
				source: 'track-crop',
				layout: { 'line-cap': 'round', 'line-join': 'round' },
				paint: { 'line-color': '#b91c1c', 'line-width': 5 }
			});

			const start = points[0];
			const end = points[points.length - 1];
			new maplibregl.Marker({ color: '#16a34a' })
				.setLngLat([start.lon, start.lat])
				.addTo(map);
			new maplibregl.Marker({ color: '#dc2626' })
				.setLngLat([end.lon, end.lat])
				.addTo(map);

			// Hovering near the track mirrors the position onto the elevation
			// chart (the same two-way hoverDistM binding the chart feeds us).
			// Deliberately not a track-layer event: snapping within SNAP_PX
			// beats having to hit the 7px line pixel-perfectly.
			map.on('mousemove', (e) => {
				const distM = snapToTrack(e);
				hoverDistM = distM;
				if (map) map.getCanvas().style.cursor = distM != null ? 'crosshair' : '';
			});
			map.on('mouseout', () => {
				hoverDistM = null;
			});
			// Drop a pin anywhere near the route: the marker snaps to the
			// nearest track point when the click lands within SNAP_PX of it.
			map.on('click', (e) => {
				if (!onPlaceMarker) return;
				const distM = snapToTrack(e);
				if (distM != null) onPlaceMarker(distM);
			});

			ready = true;
		});
	});

	onDestroy(() => {
		hoverMarker?.remove();
		markerAEl?.remove();
		markerBEl?.remove();
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

	$effect(() => {
		if (!ready || !map) return;
		if (markerA == null) {
			markerAEl?.remove();
			markerAEl = null;
		} else {
			const p = findPointAtDistance(points, markerA);
			if (!markerAEl) {
				markerAEl = new maplibregl.Marker({ element: makeLabelEl('A', '#059669') })
					.setLngLat([p.lon, p.lat])
					.addTo(map);
			} else {
				markerAEl.setLngLat([p.lon, p.lat]);
			}
		}
	});

	$effect(() => {
		if (!ready || !map) return;
		if (markerB == null) {
			markerBEl?.remove();
			markerBEl = null;
		} else {
			const p = findPointAtDistance(points, markerB);
			if (!markerBEl) {
				markerBEl = new maplibregl.Marker({ element: makeLabelEl('B', '#dc2626') })
					.setLngLat([p.lon, p.lat])
					.addTo(map);
			} else {
				markerBEl.setLngLat([p.lon, p.lat]);
			}
		}
	});

	$effect(() => {
		if (!ready || !map) return;
		const src = map.getSource('track-crop') as maplibregl.GeoJSONSource | undefined;
		if (!src) return;
		if (markerA == null || markerB == null) {
			src.setData({
				type: 'Feature',
				geometry: { type: 'LineString', coordinates: [] },
				properties: {}
			});
			return;
		}
		const [startM, endM] =
			markerA <= markerB ? [markerA, markerB] : [markerB, markerA];
		src.setData({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: cropCoords(startM, endM) },
			properties: {}
		});
	});
</script>

<div bind:this={container} class="h-[480px] w-full overflow-hidden rounded-lg border border-neutral-200"></div>
