import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { parseGpx, GpxParseError } from '$lib/gpx.js';
import { slugify } from '$lib/slug.js';
import { listRoutes, routeExists, writeRoute } from '$lib/server/storage.js';
import type { RouteData } from '$lib/types.js';

const MAX_GPX_BYTES = 15 * 1024 * 1024;

export const load: PageServerLoad = async () => {
	return { routes: await listRoutes() };
};

export const actions: Actions = {
	upload: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const file = form.get('file');

		if (!name) return fail(400, { error: 'Name is required', name: '' });
		const id = slugify(name);
		if (!id) {
			return fail(400, {
				error: 'Name must contain letters or numbers',
				name
			});
		}
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'GPX file is required', name });
		}
		if (file.size > MAX_GPX_BYTES) {
			return fail(400, { error: 'GPX file is too large (max 15 MB)', name });
		}
		if (await routeExists(id)) {
			return fail(409, {
				error: `A route with id "${id}" already exists`,
				name
			});
		}

		const gpxText = await file.text();
		let parsed;
		try {
			parsed = parseGpx(gpxText);
		} catch (err) {
			const msg = err instanceof GpxParseError ? err.message : 'Failed to parse GPX';
			return fail(400, { error: msg, name });
		}

		const route: RouteData = {
			id,
			name,
			points: parsed.points,
			totalDistM: parsed.totalDistM,
			totalAscentM: parsed.totalAscentM,
			bounds: parsed.bounds,
			createdAt: new Date().toISOString()
		};
		await writeRoute(id, gpxText, route);

		return { success: true, id };
	}
};
