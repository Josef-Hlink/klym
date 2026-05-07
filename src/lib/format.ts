export function fmtKm(m: number, decimals = 2): string {
	return `${(m / 1000).toFixed(decimals)} km`;
}

export function fmtM(m: number): string {
	return `${Math.round(m)} m`;
}

// Compact variant for the export image's start/end labels: no space, drops
// the decimal once we're past 10 km so labels don't overflow the bar.
export function fmtDist(m: number): string {
	const km = m / 1000;
	return km >= 10 ? `${km.toFixed(0)}km` : `${km.toFixed(1)}km`;
}
