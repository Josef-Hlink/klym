import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { parseGpx, GpxParseError } from '$lib/gpx.js';
import { slugify } from '$lib/slug.js';
import {
	deleteRoute,
	listRoutes,
	routeExists,
	updateRouteName,
	writeRoute
} from '$lib/server/storage.js';
import type { RouteData } from '$lib/types.js';

const MAX_GPX_BYTES = 15 * 1024 * 1024;

export const load: PageServerLoad = async () => {
	return { routes: await listRoutes() };
};

export const actions: Actions = {
	upload: async ({ request }) => {
		const form = await request.formData();
		const rawName = String(form.get('name') ?? '').trim();
		const file = form.get('file');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { scope: 'upload', error: 'GPX file is required', name: rawName });
		}
		if (file.size > MAX_GPX_BYTES) {
			return fail(400, { scope: 'upload', error: 'GPX file is too large (max 15 MB)', name: rawName });
		}

		const name = rawName || file.name.replace(/\.gpx$/i, '').trim();
		const id = slugify(name);
		if (!id) {
			return fail(400, {
				scope: 'upload',
				error: 'Name must contain letters or numbers',
				name: rawName
			});
		}
		if (await routeExists(id)) {
			return fail(409, {
				scope: 'upload',
				error: `A route with id "${id}" already exists`,
				name: rawName
			});
		}

		const gpxText = await file.text();
		let parsed;
		try {
			parsed = parseGpx(gpxText);
		} catch (err) {
			const msg = err instanceof GpxParseError ? err.message : 'Failed to parse GPX';
			return fail(400, { scope: 'upload', error: msg, name });
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

		return { scope: 'upload', success: true, id };
	},

	renameRoute: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		if (!id) return fail(400, { scope: 'rename', error: 'Missing route id' });
		if (!name) return fail(400, { scope: 'rename', error: 'Name cannot be empty', id });
		const ok = await updateRouteName(id, name);
		if (!ok) return fail(404, { scope: 'rename', error: 'Route not found', id });
		return { scope: 'rename', success: true, id };
	},

	deleteRoute: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '').trim();
		if (!id) return fail(400, { scope: 'delete', error: 'Missing route id' });
		const ok = await deleteRoute(id);
		if (!ok) return fail(404, { scope: 'delete', error: 'Route not found', id });
		return { scope: 'delete', success: true, id };
	}
};
