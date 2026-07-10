// Shared Protomaps basemap loader — the self-hosted vector tiles at
// tiles.hlink.dev (PMTiles Europe archive + glyphs + sprites, CORS and Range
// handled by the vhost). The style is built client-side; there is no
// style.json to fetch.
//
// All heavy deps (maplibre-gl, pmtiles, @protomaps/basemaps) load via dynamic
// import so pages without a map never pull them into their chunk. klym is
// light-theme only, so only the 'light' flavor is built.
import type { StyleSpecification } from 'maplibre-gl';

export const TILES_ORIGIN = 'https://tiles.hlink.dev';

export const PROTOMAPS_ATTRIBUTION =
	'<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export async function loadBasemap() {
	const [{ default: ml }, { Protocol }, { layers, namedFlavor }] = await Promise.all([
		import('maplibre-gl'),
		import('pmtiles'),
		import('@protomaps/basemaps')
	]);

	// Re-registering on remount just overwrites — harmless.
	ml.addProtocol('pmtiles', new Protocol().tile);

	const style: StyleSpecification = {
		version: 8,
		glyphs: `${TILES_ORIGIN}/fonts/{fontstack}/{range}.pbf`,
		sprite: `${TILES_ORIGIN}/sprites/v4/light`,
		sources: {
			protomaps: {
				type: 'vector',
				url: `pmtiles://${TILES_ORIGIN}/europe.pmtiles`,
				attribution: PROTOMAPS_ATTRIBUTION
			}
		},
		layers: layers('protomaps', namedFlavor('light'), { lang: 'en' })
	};

	return { ml, style };
}
