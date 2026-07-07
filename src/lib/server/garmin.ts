// The "current route" slot for the Garmin Connect IQ data field (garmin/).
//
// The device fetch carries no session cookie, so this lives outside the
// owner-scoped storage: one process-lifetime slot, gated by a shared secret
// (KLYM_GARMIN_TOKEN from the runtime environment — unset means the whole
// feature is off). Like the rest of klym's storage it's ephemeral: every
// restart/deploy empties the slot and the user just re-sends the route.
// If this ever grows past a single user, the slot becomes a Map keyed by
// per-user token; the endpoints don't need to change shape for that.

import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { GarminPayload } from '$lib/garmin.js';

export function garminEnabled(): boolean {
	return !!env.KLYM_GARMIN_TOKEN;
}

export function checkGarminToken(token: string | null | undefined): boolean {
	const secret = env.KLYM_GARMIN_TOKEN;
	if (!secret || !token) return false;
	const a = Buffer.from(token);
	const b = Buffer.from(secret);
	return a.length === b.length && timingSafeEqual(a, b);
}

let slot: { payload: GarminPayload; createdAt: number } | null = null;

export function setGarminSlot(payload: GarminPayload): void {
	slot = { payload, createdAt: Date.now() };
}

export function getGarminSlot(): GarminPayload | null {
	return slot?.payload ?? null;
}
