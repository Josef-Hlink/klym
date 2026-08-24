import { describe, expect, it } from 'vitest';
import { db } from './db.js';

// Gated the same way as storage.test.ts — see the note there.
const hasDb = !!process.env.DATABASE_URL;

// Regression guard: the pool has to close itself on shutdown. adapter-node
// closes the HTTP server and emits 'sveltekit:shutdown', but postgres.js keeps
// its sockets open, so without this the event loop never drains — node never
// exits, systemd sits in stop-sigterm for TimeoutStopSec, and the deploy eats a
// SIGKILL on every restart. Lives in its own file so ending the pool can't
// disturb the storage suite.
describe.skipIf(!hasDb)('db shutdown', () => {
	it('closes the pool when adapter-node signals shutdown', async () => {
		const sql = await db();
		expect(await sql`select 1 as ok`).toEqual([{ ok: 1 }]);

		// db() must have registered exactly one listener, not zero and not one
		// per call.
		await db();
		expect(process.listenerCount('sveltekit:shutdown')).toBe(1);

		process.emit('sveltekit:shutdown', 'SIGTERM' as never);
		// Let the once() handler run to completion.
		await new Promise((r) => setTimeout(r, 200));

		// A closed pool rejects instead of silently reconnecting.
		await expect(sql`select 1`).rejects.toThrow();
	});
});
