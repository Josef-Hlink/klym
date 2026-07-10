// Off-screen MapLibre GL snapshot of the self-hosted Protomaps vector
// basemap, shaped as a TileImage so everything downstream of buildTileImage
// (tile transform, block faces, the <image matrix()> element, fade) is
// untouched.
//
// DOM + WebGL touching: needs document and a GL context. Run only in the
// browser (the segment/explore pages are `ssr = false`). The heavy deps stay
// behind loadBasemap's dynamic imports, so importing this module is free
// until the user actually picks the vector source.
import { loadBasemap } from '$lib/basemap.js';
import { snapshotCamera, snapshotDims, type TileBBox, type TileImage } from './tiles.js';

// A style that never reaches idle (tiles origin down, glyph fetch hanging)
// must not wedge the rebuild effect forever.
const IDLE_TIMEOUT_MS = 30_000;

export async function buildVectorTileImage(bbox: TileBBox): Promise<TileImage | null> {
	const dims = snapshotDims(bbox);
	if (!dims) return null;
	const { ml, style } = await loadBasemap();

	// Hidden container: canvas aspect == the bbox's Mercator aspect, which
	// makes the explicit camera below an exact fit.
	const container = document.createElement('div');
	container.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${dims.width}px;height:${dims.height}px;`;
	document.body.appendChild(container);

	const { center, zoom } = snapshotCamera(bbox, dims.width);
	const map = new ml.Map({
		container,
		style,
		center,
		zoom,
		interactive: false,
		attributionControl: false,
		// Without preserveDrawingBuffer the GL buffer is cleared before toDataURL.
		canvasContextAttributes: { preserveDrawingBuffer: true },
		pixelRatio: 1, // canvas px == CSS px, deterministic size regardless of screen DPR
		fadeDuration: 0 // don't capture labels mid-fade
	});
	try {
		await new Promise<void>((resolve, reject) => {
			// Individual missing tiles (bbox edge outside the Europe archive)
			// are skipped silently by MapLibre — same philosophy as the raster
			// path's onerror-resolve.
			const t = setTimeout(() => reject(new Error('vector snapshot timeout')), IDLE_TIMEOUT_MS);
			map.once('idle', () => {
				clearTimeout(t);
				resolve();
			});
		});
		return {
			url: map.getCanvas().toDataURL('image/png'),
			minLat: bbox.minLat,
			maxLat: bbox.maxLat,
			minLon: bbox.minLon,
			maxLon: bbox.maxLon
		};
	} finally {
		map.remove(); // frees the WebGL context promptly
		container.remove();
	}
}
