import { XMLParser } from 'fast-xml-parser';
import { haversineM } from './geo.js';
import type { RouteBounds, RoutePoint } from './types.js';

type RawPt = {
	'@_lat'?: string | number;
	'@_lon'?: string | number;
	ele?: string | number;
	time?: string;
};

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseAttributeValue: false,
	parseTagValue: false,
	isArray: (name) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept'].includes(name)
});

export class GpxParseError extends Error {}

export type ParsedGpx = {
	points: RoutePoint[];
	totalDistM: number;
	totalAscentM: number;
	bounds: RouteBounds;
};

export function parseGpx(xml: string): ParsedGpx {
	let doc: any;
	try {
		doc = parser.parse(xml);
	} catch (err) {
		throw new GpxParseError(`Invalid XML: ${(err as Error).message}`);
	}

	const gpx = doc?.gpx;
	if (!gpx) throw new GpxParseError('Missing <gpx> root element');

	const rawPts: RawPt[] = [];
	for (const trk of gpx.trk ?? []) {
		for (const seg of trk.trkseg ?? []) {
			for (const pt of seg.trkpt ?? []) rawPts.push(pt);
		}
	}
	if (rawPts.length === 0) {
		for (const rte of gpx.rte ?? []) {
			for (const pt of rte.rtept ?? []) rawPts.push(pt);
		}
	}
	if (rawPts.length < 2) {
		throw new GpxParseError('GPX contains fewer than 2 track/route points');
	}

	const points: RoutePoint[] = [];
	let totalDistM = 0;
	let totalAscentM = 0;
	let minLat = Infinity, maxLat = -Infinity;
	let minLon = Infinity, maxLon = -Infinity;
	let minEle = Infinity, maxEle = -Infinity;
	let prev: RoutePoint | null = null;

	for (const raw of rawPts) {
		const lat = Number(raw['@_lat']);
		const lon = Number(raw['@_lon']);
		const ele = raw.ele != null ? Number(raw.ele) : NaN;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		const eleVal = Number.isFinite(ele) ? ele : (prev?.ele ?? 0);

		if (prev) {
			const d = haversineM(prev.lat, prev.lon, lat, lon);
			totalDistM += d;
			if (eleVal > prev.ele) totalAscentM += eleVal - prev.ele;
		}

		const pt: RoutePoint = {
			lat,
			lon,
			ele: eleVal,
			cumDistM: totalDistM,
			...(typeof raw.time === 'string' ? { time: raw.time } : {})
		};
		points.push(pt);
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
		if (eleVal < minEle) minEle = eleVal;
		if (eleVal > maxEle) maxEle = eleVal;
		prev = pt;
	}

	if (points.length < 2) {
		throw new GpxParseError('GPX contains fewer than 2 valid points');
	}

	return {
		points,
		totalDistM,
		totalAscentM,
		bounds: { minLat, maxLat, minLon, maxLon, minEle, maxEle }
	};
}
