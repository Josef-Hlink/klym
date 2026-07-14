// Hillshade bake for the terrain ground texture: multiply the per-cell
// lambert shade (dem.ts computeShade) over the composited ground image so
// slopes facing away from the light darken. Baked once per texture/grid
// pair — the shading is world-fixed (NW sun), so it rotates with the map
// like a real cartographic hillshade and costs nothing per frame.
//
// DOM-touching (canvas); lives outside dem.ts so buildDemGrid stays that
// module's only DOM function. Purely cosmetic: returns the original
// texture on any failure. Synchronous — the input texture is already a
// canvas, so there's nothing to decode.

import { computeShade, type DemGrid } from './dem.js';
import type { TileImage } from './tiles.js';

export const SHADE_ALPHA = 0.35;

export function bakeHillshade(texture: TileImage, grid: DemGrid): TileImage {
	try {
		const canvas = document.createElement('canvas');
		canvas.width = texture.source.width;
		canvas.height = texture.source.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return texture;
		ctx.drawImage(texture.source, 0, 0);

		// Greyscale shade at cell resolution; the smoothed upscale below turns
		// per-cell values into a soft gradient across the full texture.
		const cellsX = grid.w - 1;
		const cellsY = grid.h - 1;
		const shade = computeShade(grid);
		const shadeCanvas = document.createElement('canvas');
		shadeCanvas.width = cellsX;
		shadeCanvas.height = cellsY;
		const sctx = shadeCanvas.getContext('2d');
		if (!sctx) return texture;
		const shadeImg = sctx.createImageData(cellsX, cellsY);
		for (let i = 0; i < shade.length; i++) {
			const v = Math.round(shade[i] * 255);
			shadeImg.data[i * 4] = v;
			shadeImg.data[i * 4 + 1] = v;
			shadeImg.data[i * 4 + 2] = v;
			shadeImg.data[i * 4 + 3] = 255;
		}
		sctx.putImageData(shadeImg, 0, 0);

		ctx.globalCompositeOperation = 'multiply';
		ctx.globalAlpha = SHADE_ALPHA;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(shadeCanvas, 0, 0, canvas.width, canvas.height);
		ctx.globalCompositeOperation = 'source-over';
		ctx.globalAlpha = 1;

		return { ...texture, source: canvas };
	} catch {
		return texture;
	}
}
