import { describe, it, expect } from 'vitest';
import { parseGpx } from './gpx.js';

const ACTIVITY_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk><trkseg>
    <trkpt lat="45.0" lon="5.0">
      <ele>100</ele>
      <time>2024-01-01T00:00:00Z</time>
      <extensions>
        <power>200</power>
        <gpxtpx:TrackPointExtension>
          <gpxtpx:hr>140</gpxtpx:hr>
          <gpxtpx:cad>80</gpxtpx:cad>
        </gpxtpx:TrackPointExtension>
      </extensions>
    </trkpt>
    <trkpt lat="45.001" lon="5.0">
      <ele>110</ele>
      <time>2024-01-01T00:00:10Z</time>
      <extensions>
        <power>220</power>
        <gpxtpx:TrackPointExtension>
          <gpxtpx:hr>148</gpxtpx:hr>
          <gpxtpx:cad>82</gpxtpx:cad>
        </gpxtpx:TrackPointExtension>
      </extensions>
    </trkpt>
  </trkseg></trk>
</gpx>`;

const ROUTE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="45.0" lon="5.0"><ele>100</ele></trkpt>
    <trkpt lat="45.001" lon="5.0"><ele>110</ele></trkpt>
  </trkseg></trk>
</gpx>`;

describe('parseGpx activity streams', () => {
	it('extracts hr, cadence, and power from Strava-style extensions', () => {
		const { points } = parseGpx(ACTIVITY_GPX);
		expect(points).toHaveLength(2);
		expect(points[0].hr).toBe(140);
		expect(points[0].cad).toBe(80);
		expect(points[0].power).toBe(200);
		expect(points[1].hr).toBe(148);
		expect(points[1].cad).toBe(82);
		expect(points[1].power).toBe(220);
	});

	it('derives speed (m/s) from time + cumDistM deltas', () => {
		const { points } = parseGpx(ACTIVITY_GPX);
		// ~111m over 10s → ~11.1 m/s. Both points get a value (last reuses prev).
		expect(points[0].spd).toBeGreaterThan(10);
		expect(points[0].spd).toBeLessThan(12);
		expect(points[1].spd).toBe(points[0].spd);
	});

	it('leaves stream fields undefined for plain route GPX', () => {
		const { points } = parseGpx(ROUTE_GPX);
		expect(points[0].hr).toBeUndefined();
		expect(points[0].power).toBeUndefined();
		expect(points[0].cad).toBeUndefined();
		expect(points[0].spd).toBeUndefined();
		expect(points[0].time).toBeUndefined();
	});
});
