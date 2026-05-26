import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import {
	deleteSegment,
	listSegments,
	readRoute,
	segmentExists,
	updateSegment,
	writeSegment
} from '$lib/server/storage.js';
import { slugify } from '$lib/slug.js';
import type { SegmentData } from '$lib/types.js';

export const load: PageServerLoad = async ({ params, locals }) => {
	const route = await readRoute(locals.owner, params.id);
	if (!route) throw error(404, `Route "${params.id}" not found`);
	const segments = await listSegments(locals.owner, params.id);
	return { route, segments };
};

export const actions: Actions = {
	saveSegment: async ({ request, params, locals }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const startDistM = Number(form.get('startDistM'));
		const endDistM = Number(form.get('endDistM'));
		const binSizeM = Number(form.get('binSizeM') ?? 500);

		if (!name) return fail(400, { scope: 'save', error: 'Name is required', name: '' });
		const id = slugify(name);
		if (!id) {
			return fail(400, {
				scope: 'save',
				error: 'Name must contain letters or numbers',
				name
			});
		}
		if (!Number.isFinite(startDistM) || !Number.isFinite(endDistM)) {
			return fail(400, { scope: 'save', error: 'Invalid selection', name });
		}
		if (endDistM - startDistM < 10) {
			return fail(400, {
				scope: 'save',
				error: 'Selection is too short (min 10 m)',
				name
			});
		}
		if (await segmentExists(locals.owner, params.id, id)) {
			return fail(409, {
				scope: 'save',
				error: `A segment with id "${id}" already exists`,
				name
			});
		}

		const segment: SegmentData = {
			id,
			routeId: params.id,
			name,
			startDistM,
			endDistM,
			binSizeM: binSizeM > 0 ? binSizeM : 500,
			createdAt: new Date().toISOString()
		};
		await writeSegment(locals.owner, segment);

		return { scope: 'save', success: true, id };
	},

	deleteSegment: async ({ request, params, locals }) => {
		const form = await request.formData();
		const segId = String(form.get('segId') ?? '').trim();
		if (!segId) return fail(400, { scope: 'delete', error: 'Missing segment id' });
		const ok = await deleteSegment(locals.owner, params.id, segId);
		if (!ok) return fail(404, { scope: 'delete', error: 'Segment not found' });
		return { scope: 'delete', success: true, id: segId };
	},

	renameSegment: async ({ request, params, locals }) => {
		const form = await request.formData();
		const segId = String(form.get('segId') ?? '').trim();
		const name = String(form.get('name') ?? '').trim();
		if (!segId) return fail(400, { scope: 'rename', error: 'Missing segment id' });
		if (!name) return fail(400, { scope: 'rename', error: 'Name cannot be empty', segId });
		const ok = await updateSegment(locals.owner, params.id, segId, { name });
		if (!ok) return fail(404, { scope: 'rename', error: 'Segment not found', segId });
		return { scope: 'rename', success: true, id: segId };
	},

	adjustSegment: async ({ request, params, locals }) => {
		const form = await request.formData();
		const segId = String(form.get('segId') ?? '').trim();
		const startDistM = Number(form.get('startDistM'));
		const endDistM = Number(form.get('endDistM'));
		if (!segId) return fail(400, { scope: 'adjust', error: 'Missing segment id' });
		if (!Number.isFinite(startDistM) || !Number.isFinite(endDistM)) {
			return fail(400, { scope: 'adjust', error: 'Invalid bounds', segId });
		}
		if (endDistM - startDistM < 10) {
			return fail(400, { scope: 'adjust', error: 'Selection too short (min 10 m)', segId });
		}
		const ok = await updateSegment(locals.owner, params.id, segId, { startDistM, endDistM });
		if (!ok) return fail(404, { scope: 'adjust', error: 'Segment not found', segId });
		return { scope: 'adjust', success: true, id: segId };
	}
};
