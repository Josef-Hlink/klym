import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { readRoute } from '$lib/server/storage.js';

// Ephemeral segment view: bounds come straight from the query string, nothing
// is read from or written to segment storage. This is how detected climbs and
// descents are opened — exploring never requires saving.
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const route = await readRoute(locals.owner, params.id);
	if (!route) throw error(404, `Route "${params.id}" not found`);

	const from = Number(url.searchParams.get('from'));
	const to = Number(url.searchParams.get('to'));
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		throw error(400, 'Missing or invalid "from"/"to" bounds');
	}
	const startM = Math.min(Math.max(0, from), route.totalDistM);
	const endM = Math.min(Math.max(startM, to), route.totalDistM);
	if (endM - startM < 10) throw error(400, 'Selection is too short (min 10 m)');

	const name =
		url.searchParams.get('name')?.trim() ||
		`km ${(startM / 1000).toFixed(1)} – ${(endM / 1000).toFixed(1)}`;
	return { route, startM, endM, name };
};
