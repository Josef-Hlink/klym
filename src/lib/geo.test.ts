import { describe, it, expect } from 'vitest';
import { haversineM } from './geo.js';

describe('haversineM', () => {
	it('returns 0 for identical points', () => {
		expect(haversineM(45, 5, 45, 5)).toBe(0);
	});

	it('matches a known short pair within 1m', () => {
		// Two points ~1110m apart along a meridian (0.01 deg of latitude).
		const d = haversineM(45.0, 5.0, 45.01, 5.0);
		expect(d).toBeGreaterThan(1110);
		expect(d).toBeLessThan(1115);
	});

	it('is symmetric', () => {
		const a = haversineM(48.85, 2.35, 51.51, -0.13);
		const b = haversineM(51.51, -0.13, 48.85, 2.35);
		expect(a).toBeCloseTo(b, 6);
	});

	it('paris to london is roughly 343 km', () => {
		const d = haversineM(48.8566, 2.3522, 51.5074, -0.1278);
		expect(d / 1000).toBeGreaterThan(340);
		expect(d / 1000).toBeLessThan(346);
	});

	it('handles antipodal points without NaN', () => {
		const d = haversineM(0, 0, 0, 180);
		expect(Number.isFinite(d)).toBe(true);
		expect(d / 1000).toBeGreaterThan(20015);
		expect(d / 1000).toBeLessThan(20040);
	});
});
