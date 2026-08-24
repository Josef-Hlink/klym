import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RouteData, SegmentData } from '$lib/types.js';
import { db } from './db.js';
import {
	deleteRoute,
	deleteSegment,
	listRoutes,
	listSegments,
	readRoute,
	readSegment,
	routeExists,
	segmentExists,
	updateRouteName,
	updateSegment,
	writeRoute,
	writeSegment
} from './storage.js';

// Integration spec: needs a real postgres. Skipped unless DATABASE_URL is set,
// so `pnpm test` stays fast and pure for anyone without a local cluster.
//   createdb -h /tmp klym
//   DATABASE_URL=postgresql:///klym?host=/tmp pnpm test
const hasDb = !!process.env.DATABASE_URL;

const OWNER = 'test-owner';
const OTHER = 'test-owner-2';
const STAGE = 'vuelta-2026-stage-1';

function route(id: string, name = 'Alpe d\'Huez', createdAt = '2026-08-24T10:00:00.000Z'): RouteData {
	return {
		id,
		name,
		points: [
			{ lat: 45.1, lon: 6.1, ele: 720, cumDistM: 0 },
			{ lat: 45.2, lon: 6.2, ele: 1120, cumDistM: 5000 },
			{ lat: 45.3, lon: 6.3, ele: 1860, cumDistM: 13900 }
		],
		totalDistM: 13900,
		totalAscentM: 1047,
		bounds: { minLat: 45.1, maxLat: 45.3, minLon: 6.1, maxLon: 6.3, minEle: 720, maxEle: 1860 },
		createdAt
	};
}

function segment(routeId: string, id: string, createdAt = '2026-08-24T11:00:00.000Z'): SegmentData {
	return {
		id,
		routeId,
		name: id,
		startDistM: 0,
		endDistM: 13900,
		binSizeM: 500,
		createdAt
	};
}

describe.skipIf(!hasDb)('storage (postgres)', () => {
	beforeEach(async () => {
		const sql = await db();
		await sql`delete from owners where id in (${OWNER}, ${OTHER})`;
	});

	afterAll(async () => {
		const sql = await db();
		await sql`delete from owners where id in (${OWNER}, ${OTHER})`;
		await sql.end();
	});

	it('round-trips a route through write/read', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		const got = await readRoute(OWNER, 'alpe');
		expect(got).toEqual(route('alpe'));
	});

	it('lists route metadata without the points blob', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		const [summary] = await listRoutes(OWNER);
		expect(summary).toEqual({
			id: 'alpe',
			name: "Alpe d'Huez",
			totalDistM: 13900,
			totalAscentM: 1047,
			pointCount: 3,
			createdAt: '2026-08-24T10:00:00.000Z'
		});
		expect(summary).not.toHaveProperty('points');
	});

	it('sorts listRoutes newest first', async () => {
		await writeRoute(OWNER, 'old', route('old', 'Old', '2026-01-01T00:00:00.000Z'));
		await writeRoute(OWNER, 'new', route('new', 'New', '2026-08-01T00:00:00.000Z'));
		expect((await listRoutes(OWNER)).map((r) => r.id)).toEqual(['new', 'old']);
	});

	it('scopes routes per owner', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		expect(await readRoute(OTHER, 'alpe')).toBeNull();
		expect(await listRoutes(OTHER)).toEqual([]);
	});

	it('overwrites on a repeat write of the same id', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		await writeRoute(OWNER, 'alpe', route('alpe', 'Renamed'));
		expect((await listRoutes(OWNER)).length).toBe(1);
		expect((await readRoute(OWNER, 'alpe'))?.name).toBe('Renamed');
	});

	it('renames and deletes a route', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		expect(await updateRouteName(OWNER, 'alpe', 'Bourg → Alpe')).toBe(true);
		expect((await readRoute(OWNER, 'alpe'))?.name).toBe('Bourg → Alpe');
		expect(await deleteRoute(OWNER, 'alpe')).toBe(true);
		expect(await deleteRoute(OWNER, 'alpe')).toBe(false);
		expect(await readRoute(OWNER, 'alpe')).toBeNull();
	});

	it('reports existence, including builtin stages', async () => {
		expect(await routeExists(OWNER, 'nope')).toBe(false);
		expect(await routeExists(OWNER, STAGE)).toBe(true);
		await writeRoute(OWNER, 'alpe', route('alpe'));
		expect(await routeExists(OWNER, 'alpe')).toBe(true);
	});

	it('round-trips segments and cascades them on route delete', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		await writeSegment(OWNER, segment('alpe', 'climb-1'));
		expect(await segmentExists(OWNER, 'alpe', 'climb-1')).toBe(true);
		expect(await readSegment(OWNER, 'alpe', 'climb-1')).toEqual(segment('alpe', 'climb-1'));
		expect(await listSegments(OWNER, 'alpe')).toHaveLength(1);

		await deleteRoute(OWNER, 'alpe');
		expect(await listSegments(OWNER, 'alpe')).toEqual([]);
	});

	it('patches a segment and leaves untouched fields alone', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		await writeSegment(OWNER, segment('alpe', 'climb-1'));
		expect(await updateSegment(OWNER, 'alpe', 'climb-1', { name: 'Lacets', binSizeM: 250 })).toBe(
			true
		);
		const got = await readSegment(OWNER, 'alpe', 'climb-1');
		expect(got?.name).toBe('Lacets');
		expect(got?.binSizeM).toBe(250);
		expect(got?.endDistM).toBe(13900);
		expect(await updateSegment(OWNER, 'alpe', 'missing', { name: 'x' })).toBe(false);
	});

	it('deletes a segment', async () => {
		await writeRoute(OWNER, 'alpe', route('alpe'));
		await writeSegment(OWNER, segment('alpe', 'climb-1'));
		expect(await deleteSegment(OWNER, 'alpe', 'climb-1')).toBe(true);
		expect(await deleteSegment(OWNER, 'alpe', 'climb-1')).toBe(false);
	});

	describe('builtin stages', () => {
		it('saves a segment onto a stage without listing the stage as a route', async () => {
			await writeSegment(OWNER, segment(STAGE, 'stage-climb'));
			expect(await listSegments(OWNER, STAGE)).toHaveLength(1);
			// The hidden overlay row must not surface under "Your routes".
			expect(await listRoutes(OWNER)).toEqual([]);
		});

		it('still reads the stage from the shared registry, not the overlay', async () => {
			await writeSegment(OWNER, segment(STAGE, 'stage-climb'));
			const got = await readRoute(OWNER, STAGE);
			expect(got?.id).toBe(STAGE);
			expect(got?.points.length).toBeGreaterThan(100);
		});

		it('refuses to rename a stage', async () => {
			await writeSegment(OWNER, segment(STAGE, 'stage-climb'));
			expect(await updateRouteName(OWNER, STAGE, 'Mine now')).toBe(false);
		});

		it('keeps stage segments per visitor', async () => {
			await writeSegment(OWNER, segment(STAGE, 'stage-climb'));
			expect(await listSegments(OTHER, STAGE)).toEqual([]);
		});

		it('ignores a segment save onto an unknown route', async () => {
			await writeSegment(OWNER, segment('does-not-exist', 'x'));
			expect(await listSegments(OWNER, 'does-not-exist')).toEqual([]);
		});
	});
});
