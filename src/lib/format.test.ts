import { describe, it, expect } from 'vitest';
import { fmtKm, fmtM, fmtDist } from './format.js';

describe('fmtKm', () => {
	it('defaults to two decimals', () => {
		expect(fmtKm(1234)).toBe('1.23 km');
	});

	it('respects a custom decimals argument', () => {
		expect(fmtKm(1234, 1)).toBe('1.2 km');
		expect(fmtKm(1234, 0)).toBe('1 km');
	});

	it('formats sub-kilometre distances', () => {
		expect(fmtKm(50)).toBe('0.05 km');
	});
});

describe('fmtM', () => {
	it('rounds to the nearest metre', () => {
		expect(fmtM(123.4)).toBe('123 m');
		expect(fmtM(123.6)).toBe('124 m');
	});

	it('handles zero and negatives', () => {
		expect(fmtM(0)).toBe('0 m');
		expect(fmtM(-5.4)).toBe('-5 m');
	});
});

describe('fmtDist', () => {
	it('uses one decimal under 10 km', () => {
		expect(fmtDist(2500)).toBe('2.5km');
		expect(fmtDist(9999)).toBe('10.0km');
	});

	it('drops the decimal at 10 km and above', () => {
		expect(fmtDist(10000)).toBe('10km');
		expect(fmtDist(42500)).toBe('43km');
	});
});
