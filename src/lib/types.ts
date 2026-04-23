export type RoutePoint = {
	lat: number;
	lon: number;
	ele: number;
	cumDistM: number;
	time?: string;
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

export type SegmentData = {
	id: string;
	routeId: string;
	name: string;
	startDistM: number;
	endDistM: number;
	binSizeM: number;
	createdAt: string;
};
