import { describe, it, expect } from 'vitest';
import { slugify } from './slug.js';

describe('slugify', () => {
	it('lowercases and dasherizes', () => {
		expect(slugify('Mont Ventoux')).toBe('mont-ventoux');
	});

	it('strips diacritics so accented and unaccented names collide', () => {
		expect(slugify('Col du Galibier')).toBe('col-du-galibier');
		expect(slugify('Côl dü Galibiér')).toBe('col-du-galibier');
	});

	it('collapses runs of non-alphanumeric to a single hyphen', () => {
		expect(slugify('A   B___C!!D')).toBe('a-b-c-d');
	});

	it('trims leading and trailing hyphens', () => {
		expect(slugify('  --hello world--  ')).toBe('hello-world');
	});

	it('caps output at 64 characters', () => {
		const long = 'a'.repeat(200);
		expect(slugify(long)).toHaveLength(64);
	});

	it('returns empty string for input with no alphanumerics', () => {
		expect(slugify('!!!---!!!')).toBe('');
		expect(slugify('')).toBe('');
	});

	it('drops emoji and other non-ASCII symbols', () => {
		expect(slugify('Climb 🚴 day')).toBe('climb-day');
	});
});
