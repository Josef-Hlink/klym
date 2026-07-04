export type RoutePoint = {
	lat: number;
	lon: number;
	ele: number;
	cumDistM: number;
	time?: string;
	hr?: number;
	power?: number;
	cad?: number;
	spd?: number;
};

export type RouteBounds = {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
	minEle: number;
	maxEle: number;
};

export type RouteData = {
	id: string;
	name: string;
	points: RoutePoint[];
	totalDistM: number;
	totalAscentM: number;
	bounds: RouteBounds;
	createdAt: string;
};

export type RouteSummary = Omit<RouteData, 'points' | 'bounds'> & {
	pointCount: number;
};

/** A builtin example route (a TdF stage) as listed on the homepage. */
export type StageSummary = RouteSummary & {
	stage: number;
	/** Race day, YYYY-MM-DD (Europe/Paris). */
	date: string;
	start: string;
	finish: string;
};

export type SegmentData = {
	id: string;
	routeId: string;
	name: string;
	startDistM: number;
	endDistM: number;
	binSizeM: number;
	createdAt: string;
};
