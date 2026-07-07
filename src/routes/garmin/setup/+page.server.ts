import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { PageServerLoad } from './$types.js';
import { checkGarminToken, garminEnabled } from '$lib/server/garmin.js';

// One-time pairing: visiting /garmin/setup?token=<secret> marks this browser
// as allowed to use "Send to Garmin" (the send action checks the cookie
// against the env token). Keeps the token out of the UI and out of the app's
// regular pages; documented in HOSTING.md.
export const load: PageServerLoad = ({ url, cookies }) => {
	if (!garminEnabled()) throw error(404, 'Not found');
	const token = url.searchParams.get('token');
	if (!token || !checkGarminToken(token)) throw error(403, 'Bad token');
	cookies.set('klym_garmin', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		maxAge: 60 * 60 * 24 * 365
	});
	return {};
};
