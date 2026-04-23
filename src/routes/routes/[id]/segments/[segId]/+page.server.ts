import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { readRoute, readSegment } from '$lib/server/storage.js';

export const load: PageServerLoad = async ({ params }) => {
	const route = await readRoute(params.id);
	if (!route) throw error(404, `Route "${params.id}" not found`);
	const segment = await readSegment(params.id, params.segId);
	if (!segment) throw error(404, `Segment "${params.segId}" not found`);
	return { route, segment };
};
