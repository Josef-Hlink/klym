import { XMLParser } from 'fast-xml-parser';
import { haversineM } from './geo.js';
import type { RouteBounds, RoutePoint } from './types.js';

type RawPt = {
	'@_lat'?: string | number;
	'@_lon'?: string | number;
	ele?: string | number;
	time?: string;
	power?: string | number;
	extensions?: Record<string, any>;
};

function readNum(v: unknown): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

// Strava activity GPX wraps streams under <extensions>:
//   <power>243</power>
//   <gpxtpx:TrackPointExtension><gpxtpx:hr>152</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad></...>
// Older Garmin exports use ns3:* prefixes, and some put power as a direct
// child of <trkpt>. We probe the common locations and ignore the rest.
function readStreams(raw: RawPt): { hr?: number; power?: number; cad?: number } {
	const ext: Record<string, any> = raw.extensions ?? {};
	const tpx: Record<string, any> =
		ext['gpxtpx:TrackPointExtension'] ?? ext['ns3:TrackPointExtension'] ?? {};
	const hr = readNum(tpx['gpxtpx:hr'] ?? tpx['ns3:hr']);
	const cad = readNum(tpx['gpxtpx:cad'] ?? tpx['ns3:cad']);
	const power =
		readNum(raw.power) ??
		readNum(ext.power) ??
		readNum(ext['gpxpx:PowerExtension']?.['gpxpx:PowerInWatts']);
	const out: { hr?: number; power?: number; cad?: number } = {};
	if (hr != null) out.hr = hr;
	if (cad != null) out.cad = cad;
	if (power != null) out.power = power;
	return out;
}

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
			...(typeof raw.time === 'string' ? { time: raw.time } : {}),
			...readStreams(raw)
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

	// Forward-diff speed (m/s) from time + cumDistM. Only set when we have
	// timestamps on both ends of an interval; the last point reuses the
	// previous reading so the readout doesn't drop off at the trailing edge.
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (a.time == null || b.time == null) continue;
		const dt = (Date.parse(b.time) - Date.parse(a.time)) / 1000;
		if (!Number.isFinite(dt) || dt <= 0) continue;
		a.spd = (b.cumDistM - a.cumDistM) / dt;
	}
	const penult = points[points.length - 2];
	if (penult.spd != null) points[points.length - 1].spd = penult.spd;

	return {
		points,
		totalDistM,
		totalAscentM,
		bounds: { minLat, maxLat, minLon, maxLon, minEle, maxEle }
	};
}
