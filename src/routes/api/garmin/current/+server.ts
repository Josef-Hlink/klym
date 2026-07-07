import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { checkGarminToken, garminEnabled, getGarminSlot } from '$lib/server/garmin.js';

// Fetched by the Connect IQ data field (via the paired phone), so: token in
// the query string (no cookies on the device) and plain JSON status bodies.
export const GET: RequestHandler = ({ url }) => {
	if (!garminEnabled() || !checkGarminToken(url.searchParams.get('token'))) {
		return json({ error: 'bad token' }, { status: 401 });
	}
	const payload = getGarminSlot();
	if (!payload) return json({ error: 'no route sent' }, { status: 404 });
	return json(payload);
};
