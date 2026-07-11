// Shared Protomaps basemap loader — the self-hosted vector tiles at
// tiles.hlink.dev (PMTiles Europe archive + glyphs + sprites, CORS and Range
// handled by the vhost). The style is built client-side; there is no
// style.json to fetch.
//
// All heavy deps (maplibre-gl, pmtiles, @protomaps/basemaps) load via dynamic
// import so pages without a map never pull them into their chunk. klym is
// light-theme only, so only the 'light' flavor is built.
import type { StyleSpecification } from 'maplibre-gl';
import type { Flavor } from '@protomaps/basemaps';

export const TILES_ORIGIN = 'https://tiles.hlink.dev';

export const PROTOMAPS_ATTRIBUTION =
	'<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// 'warm' is klym's vector look (the default below); 'light' is the stock
// Protomaps flavor, kept as the untouched baseline for comparing future
// colorscheme experiments against.
export type BasemapFlavor = 'light' | 'warm';

// The warm klym flavor: cream ground, sand roads with tan casings, olive-sage
// greens, muted teal water, warm-stone labels. Everything stays quieter than
// the orange track and the grade colors drawn on top.
const WARM_OVERRIDES: Partial<Flavor> = {
	background: '#d9d2c5',
	earth: '#efe9dc',
	buildings: '#ddd3c3',
	park_a: '#d9e0c8',
	park_b: '#b5d1a4',
	wood_a: '#d3dcc4',
	wood_b: '#a8c99a',
	scrub_a: '#dae0c9',
	scrub_b: '#b3cf9f',
	glacier: '#f4f1e8',
	sand: '#eee5cd',
	beach: '#f0e6c9',
	pedestrian: '#ece4d2',
	hospital: '#ecdcd4',
	industrial: '#e3ddd0',
	school: '#ece3d0',
	zoo: '#dfe0cc',
	military: '#e2dccc',
	aerodrome: '#e5e0d2',
	runway: '#efeadd',
	water: '#a5cfd6',
	pier: '#e6ddc9',
	railway: '#b9ac9b',
	boundaries: '#a89e8d',
	other: '#f5efe1',
	minor_service: '#f5efe1',
	minor_a: '#f7f2e5',
	minor_b: '#fdfbf4',
	link: '#fdfbf4',
	major: '#fdfbf4',
	highway: '#fdfbf4',
	minor_service_casing: '#ded4bf',
	minor_casing: '#ded4bf',
	link_casing: '#ded4bf',
	major_casing_early: '#ded4bf',
	major_casing_late: '#ded4bf',
	highway_casing_early: '#ded4bf',
	highway_casing_late: '#ded4bf',
	tunnel_other_casing: '#e6ddc9',
	tunnel_minor_casing: '#e6ddc9',
	tunnel_link_casing: '#e6ddc9',
	tunnel_major_casing: '#e6ddc9',
	tunnel_highway_casing: '#e6ddc9',
	tunnel_other: '#e8e1cf',
	tunnel_minor: '#e8e1cf',
	tunnel_link: '#e8e1cf',
	tunnel_major: '#e8e1cf',
	tunnel_highway: '#e8e1cf',
	bridges_other_casing: '#ded4bf',
	bridges_minor_casing: '#ded4bf',
	bridges_link_casing: '#ded4bf',
	bridges_major_casing: '#ded4bf',
	bridges_highway_casing: '#ded4bf',
	bridges_other: '#f5efe1',
	bridges_minor: '#fdfbf4',
	bridges_link: '#fdfbf4',
	bridges_major: '#faf7ec',
	bridges_highway: '#fdfbf4',
	roads_label_minor: '#9a8d7d',
	roads_label_minor_halo: '#fdfbf4',
	roads_label_major: '#9a8d7d',
	roads_label_major_halo: '#fdfbf4',
	ocean_label: '#7195a3',
	subplace_label: '#a09484',
	subplace_label_halo: '#efe9dc',
	city_label: '#6b6154',
	city_label_halo: '#f4efe3',
	state_label: '#c3b8a5',
	country_label: '#b0a390',
	address_label: '#9a8d7d',
	address_label_halo: '#fdfbf4',
	landcover: {
		grassland: 'rgba(222, 233, 198, 1)',
		barren: 'rgba(245, 234, 204, 1)',
		urban_area: 'rgba(232, 226, 211, 1)',
		farmland: 'rgba(228, 235, 201, 1)',
		glacier: 'rgba(255, 255, 255, 1)',
		scrub: 'rgba(233, 235, 200, 1)',
		forest: 'rgba(208, 227, 195, 1)'
	}
};

export async function loadBasemap(flavorName: BasemapFlavor = 'warm') {
	const [{ default: ml }, { Protocol }, { layers, namedFlavor }] = await Promise.all([
		import('maplibre-gl'),
		import('pmtiles'),
		import('@protomaps/basemaps')
	]);

	// Re-registering on remount just overwrites — harmless.
	ml.addProtocol('pmtiles', new Protocol().tile);

	const light = namedFlavor('light');
	const flavor: Flavor = flavorName === 'warm' ? { ...light, ...WARM_OVERRIDES } : light;

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
		layers: layers('protomaps', flavor, { lang: 'en' })
	};

	return { ml, style };
}
