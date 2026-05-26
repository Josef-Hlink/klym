import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { randomUUID } from 'node:crypto';

const COOKIE = 'klym_sid';

// Assign every visitor an anonymous id and expose it as locals.owner, which
// scopes all storage (src/lib/server/storage.ts). No max-age, so it's a
// session cookie: the browser drops it when the session ends, which together
// with the server-side idle sweep is what makes routes vanish after a visit.
export const handle: Handle = async ({ event, resolve }) => {
	let sid = event.cookies.get(COOKIE);
	if (!sid) {
		sid = randomUUID();
		event.cookies.set(COOKIE, sid, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: !dev // allow plain-http on the dev port; require https in prod
		});
	}
	event.locals.owner = sid;
	return resolve(event);
};
