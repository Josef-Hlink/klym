<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { findPointAtDistance, gradeColor, type ColorTheme, type GradeBin } from '$lib/elevation.js';
	import { fmtKm, fmtM } from '$lib/format.js';
	import {
		ANCHOR_STEP_M,
		buildAllDrapes,
		buildAnchorLines,
		buildBlockFaces,
		buildBoundaryAnchors,
		buildHoverHighlight,
		buildPolylineRuns,
		buildShadowPoints,
		buildTileTransform
	} from '$lib/topo/geometry.js';
	import { buildDemGrid, demEleAt, type DemGrid } from '$lib/topo/dem.js';
	import {
		buildClipTriangles,
		buildTerrainBlockFaces,
		buildTerrainMesh,
		pointInPolygon,
		terrainDrawOrder
	} from '$lib/topo/terrain.js';
	import { bakeHillshade } from '$lib/topo/hillshade.js';
	import { createMeshCache, renderScene } from '$lib/topo/paint.js';
	import { buildScene, type SceneOp } from '$lib/topo/scene.js';
	import { computeVisibility, visibleAtDist } from '$lib/topo/visibility.js';
	import {
		clampDataAspect,
		computeDimensions,
		computeRefFrame,
		makeProjector,
		MAX_CANVAS_ASPECT,
		MIN_CANVAS_ASPECT,
		PAD,
		VB_W,
		type Projected
	} from '$lib/topo/projection.js';
	import {
		BLOCK_DEPTH_M,
		buildTileImage,
		computePaddedTileBBox,
		pickTileZoom,
		tileFadeOpacity,
		TILE_SOURCES,
		type MapSource,
		type TileImage
	} from '$lib/topo/tiles.js';
	import { buildVectorTileImage } from '$lib/topo/vectorTile.js';
	import {
		applyZoomAtCursor,
		clampViewport,
		computeViewTransform,
		defaultViewport,
		isZoomedOrPanned,
		type Viewport
	} from '$lib/topo/viewport.js';
	import type { RoutePoint } from '$lib/types.js';

	type Props = {
		points: RoutePoint[];
		startDistM: number;
		endDistM: number;
		bins: GradeBin[];
		theme?: ColorTheme;
		hoverDistM?: number | null;
		externalHoverDistM?: number | null;
	};
	let {
		points,
		startDistM,
		endDistM,
		bins,
		theme = 'klym',
		hoverDistM = $bindable(null),
		externalHoverDistM = null
	}: Props = $props();


	const STROKE = 6;
	const DRAG_THRESHOLD_PX = 4;
	const HOVER_PX = 24;
	// Window (metres) for the hover tooltip's "precise" grade. Centred on
	// distM, so the grade is averaged over distM ± HOVER_GRADE_WINDOW_M / 2.
	// Larger = smoother, fewer per-GPX-point spikes; smaller = more local.
	const HOVER_GRADE_WINDOW_M = 50;
	let zExaggeration = $state(3);
	// Rotation sensitivity (radians per CSS pixel of drag). Pitch is negative
	// so dragging down tilts the camera up (Strava convention).
	const YAW_PER_PX = 0.005;
	const PITCH_PER_PX = -0.005;
	const PITCH_MAX = Math.PI / 2 - 0.05;

	let wrapperEl: HTMLDivElement | null = $state(null);
	let canvasEl: HTMLCanvasElement | null = $state(null);

	let yaw = $state(0);
	let pitch = $state(0);

	// 2D/3D toggle state. is3D == pitch raised; yaw alone (top-down rotated)
	// still counts as 2D. The "saved" pose mirrors live (pitch, yaw) via effect
	// while in 3D, so flattening and toggling back restores whatever the user
	// was on — even poses reached via drag rather than the toggle.
	const PITCH_PRESET_3D = Math.PI / 4;
	const TOGGLE_TRANSITION_MS = 360;
	let savedPitch = $state<number | null>(null);
	let savedYaw = $state<number | null>(null);
	const is3D = $derived(pitch > 0.01);
	let isToggleAnimating = false;
	let toggleAnimFrame: number | null = null;

	$effect(() => {
		// Skip while the toggle animation is interpolating — those are transient
		// values, not the user's "real" 3D pose. Drag-driven rotation has
		// isToggleAnimating=false so it still saves continuously.
		if (pitch > 0.01 && !isToggleAnimating) {
			savedPitch = pitch;
			savedYaw = yaw;
		}
	});

	function cancelToggleAnim() {
		if (toggleAnimFrame !== null) {
			cancelAnimationFrame(toggleAnimFrame);
			toggleAnimFrame = null;
		}
		isToggleAnimating = false;
	}

	function toggle3D() {
		const targetPitch = is3D ? 0 : (savedPitch ?? PITCH_PRESET_3D);
		const targetYaw = is3D ? 0 : (savedYaw ?? 0);
		cancelToggleAnim();
		const startPitch = pitch;
		const startYaw = yaw;
		const t0 = performance.now();
		isToggleAnimating = true;
		const tick = (now: number) => {
			const t = Math.min(1, (now - t0) / TOGGLE_TRANSITION_MS);
			const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
			pitch = startPitch + (targetPitch - startPitch) * eased;
			yaw = startYaw + (targetYaw - startYaw) * eased;
			if (t < 1) {
				toggleAnimFrame = requestAnimationFrame(tick);
			} else {
				toggleAnimFrame = null;
				isToggleAnimating = false;
			}
		};
		toggleAnimFrame = requestAnimationFrame(tick);
	}

	// User-resized height (px). null = use data-derived aspect.
	let userHeight = $state<number | null>(null);
	let wrapperWidth = $state(0);

	// Cached on-screen rects for the canvas and the wrapper.
	// getBoundingClientRect forces a synchronous style/layout flush; calling
	// it per pointermove is the classic layout-thrash trap (profiled at ~19s
	// of "Recalculate style" in the SVG-painter era). The on-screen rect only
	// changes on scroll / resize / relayout, never between two moves, so
	// cache it and invalidate on those.
	let cachedSurfaceRect: DOMRect | null = null;
	let cachedWrapRect: DOMRect | null = null;
	function invalidateRects() {
		cachedSurfaceRect = null;
		cachedWrapRect = null;
	}
	function surfaceRect(): DOMRect | null {
		if (!canvasEl) return null;
		return (cachedSurfaceRect ??= canvasEl.getBoundingClientRect());
	}
	function wrapRect(): DOMRect | null {
		if (!wrapperEl) return null;
		return (cachedWrapRect ??= wrapperEl.getBoundingClientRect());
	}
	// Widget resize (userHeight) and responsive width both move/resize the rect.
	$effect(() => {
		userHeight;
		wrapperWidth;
		invalidateRects();
	});
	const USER_HEIGHT_MIN = 240;
	const USER_HEIGHT_MAX = 1400;

	let showMap = $state(true);
	let showAnchorLines = $state(true);
	let showAllDrapes = $state(false);
	// Terrain ground (DEM heightfield mesh). The route floats floatM above
	// the terrain surface so the drapes and anchor lines stay visible.
	// 0 m is fine: the route draws on top of the mesh, so a coplanar line
	// can't be clipped by it (that was a painter-era artifact) — it just
	// ghosts a little sooner at grazing angles, as a ground-level line
	// honestly should.
	let terrainOn = $state(true);
	let floatM = $state(10);
	let terrainOpacity = $state(1);
	let mapSource = $state<MapSource>('osm');
	const SOURCES: MapSource[] = ['osm', 'topo', 'sat', 'proto'];

	let showMapMenu = $state(false);
	let mapMenuHideTimer: ReturnType<typeof setTimeout> | null = null;
	function openMapMenu() {
		if (mapMenuHideTimer) {
			clearTimeout(mapMenuHideTimer);
			mapMenuHideTimer = null;
		}
		showMapMenu = true;
	}
	function closeMapMenu() {
		if (mapMenuHideTimer) clearTimeout(mapMenuHideTimer);
		mapMenuHideTimer = setTimeout(() => {
			showMapMenu = false;
			mapMenuHideTimer = null;
		}, 120);
	}

	let showTerrainPopover = $state(false);
	let terrainHideTimer: ReturnType<typeof setTimeout> | null = null;
	function openTerrainPopover() {
		if (terrainHideTimer) {
			clearTimeout(terrainHideTimer);
			terrainHideTimer = null;
		}
		showTerrainPopover = true;
	}
	function closeTerrainPopover() {
		if (terrainHideTimer) clearTimeout(terrainHideTimer);
		terrainHideTimer = setTimeout(() => {
			showTerrainPopover = false;
			terrainHideTimer = null;
		}, 120);
	}

	let showVertPopover = $state(false);
	let vertHideTimer: ReturnType<typeof setTimeout> | null = null;
	function openVert() {
		if (vertHideTimer) {
			clearTimeout(vertHideTimer);
			vertHideTimer = null;
		}
		showVertPopover = true;
	}
	function closeVert() {
		if (vertHideTimer) clearTimeout(vertHideTimer);
		// Small delay so the cursor can travel from button to popover (or back)
		// without the popover snapping shut mid-transit.
		vertHideTimer = setTimeout(() => {
			showVertPopover = false;
			vertHideTimer = null;
		}, 120);
	}

	// Clamp to exact start/end via interpolation so the route polyline, end
	// dot, and boundary anchor lines all terminate at the same point — without
	// this the polyline ends at the last GPX point ≤ endDistM, while distance-
	// based features (anchor lines) interpolate to the true segment end.
	const slicedPoints = $derived.by(() => {
		if (points.length === 0) return [] as RoutePoint[];
		const a = findPointAtDistance(points, startDistM);
		const b = findPointAtDistance(points, endDistM);
		const out: RoutePoint[] = [
			{ lat: a.lat, lon: a.lon, ele: a.ele, cumDistM: a.cumDistM }
		];
		for (const p of points) {
			if (p.cumDistM <= a.cumDistM) continue;
			if (p.cumDistM >= b.cumDistM) break;
			out.push(p);
		}
		out.push({ lat: b.lat, lon: b.lon, ele: b.ele, cumDistM: b.cumDistM });
		return out;
	});

	// Reference frame: route center in lat/lon/ele, plus 2D extents in metres.
	// The 2D extents fix the canvas size — we scale rotated points using this
	// reference scale so layout doesn't jitter as the user rotates.
	const refFrame = $derived(computeRefFrame(slicedPoints));

	// Data-driven aspect — used to size the canvas and pad the OSM tile.
	// Stable across resizes so a manual resize doesn't trigger an OSM rebuild.
	const dataAspect = $derived(clampDataAspect(refFrame));

	// Live canvas aspect: dataAspect by default, but the wrapper aspect once
	// the user has manually resized so the SVG fills without letterboxing.
	const canvasAspect = $derived(
		userHeight && wrapperWidth ? wrapperWidth / userHeight : dataAspect
	);

	const dimensions = $derived(computeDimensions(refFrame, canvasAspect));

	// Project a (lat, lon, ele) tuple into [svg_x, svg_y, depth_metres].
	// Closes over the current ctx so each derived rerun gets a fresh projector
	// matched to live yaw/pitch/zExaggeration. Falls back to a centre-of-canvas
	// stub when there's no refFrame yet.
	const project = $derived.by(() => {
		if (!refFrame) {
			const fallback: Projected = [VB_W / 2, dimensions.H / 2, 0];
			return (_lat: number, _lon: number, _ele: number) => fallback;
		}
		return makeProjector({ refFrame, dimensions, yaw, pitch, zExaggeration });
	});

	function project3d(p: RoutePoint): Projected {
		return project(p.lat, p.lon, p.ele);
	}

	let tileImage = $state<TileImage | null>(null);

	$effect(() => {
		const padded = computePaddedTileBBox(slicedPoints, refFrame, dataAspect);
		if (!padded) {
			tileImage = null;
			return;
		}
		const source = TILE_SOURCES[mapSource];
		let cancelled = false;
		const build =
			source.kind === 'vector'
				? buildVectorTileImage(padded)
				: buildTileImage(padded, pickTileZoom(padded, source.maxZoom), source.url, source.subdomains);
		build
			.then((result) => {
				if (cancelled) return;
				tileImage = result;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	// DEM grid for the terrain ground, fetched for the same padded bbox as
	// the ground texture so grid vertices and texture pixels share UV space.
	// Deliberately keyed on the ORIGINAL route (slicedPoints/refFrame) and
	// never on anything DEM-derived — substituting terrain elevations into
	// slicedPoints itself would create a DEM → refFrame → bbox → DEM loop.
	let demGrid = $state<DemGrid | null>(null);

	$effect(() => {
		if (!terrainOn) return; // keep the last grid; re-enabling is instant
		const padded = computePaddedTileBBox(slicedPoints, refFrame, dataAspect);
		if (!padded) {
			demGrid = null;
			return;
		}
		let cancelled = false;
		buildDemGrid(padded)
			.then((g) => {
				if (!cancelled) demGrid = g;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	function sameBBox(a: { minLat: number; maxLat: number; minLon: number; maxLon: number },
		b: { minLat: number; maxLat: number; minLon: number; maxLon: number }): boolean {
		return (
			a.minLat === b.minLat && a.maxLat === b.maxLat &&
			a.minLon === b.minLon && a.maxLon === b.maxLon
		);
	}

	// Terrain renders only when grid and texture agree on the bbox — during
	// a route/bbox transition one of the two is briefly stale, and a
	// mismatched UV mapping would smear the texture. Falls back to the flat
	// ground until both catch up. DEM failure (buildDemGrid → null) lands
	// here too.
	const terrainActive = $derived(
		terrainOn && showMap && !!demGrid && !!tileImage && sameBBox(demGrid.bbox, tileImage)
	);

	// Hillshade-baked ground texture (cosmetic; sync — the texture is
	// already a canvas). Once per texture/grid pair.
	const groundTexture = $derived.by(() => {
		if (terrainOn && tileImage && demGrid && sameBBox(demGrid.bbox, tileImage)) {
			return bakeHillshade(tileImage, demGrid);
		}
		return tileImage;
	});

	// Route points re-based onto the terrain surface + float offset. GPS
	// elevations stay the source of truth for stats and the hover tooltip;
	// these arrays only drive rendering. Recompute per grid/float change,
	// not per frame.
	const renderSliced = $derived.by(() => {
		const g = demGrid;
		if (!terrainActive || !g) return slicedPoints;
		return slicedPoints.map((p) => ({ ...p, ele: demEleAt(g, p.lat, p.lon) + floatM }));
	});
	const renderFull = $derived.by(() => {
		const g = demGrid;
		if (!terrainActive || !g) return points;
		return points.map((p) => ({ ...p, ele: demEleAt(g, p.lat, p.lon) + floatM }));
	});
	const groundEleAt = $derived.by(() => {
		const g = demGrid;
		if (!terrainActive || !g) return undefined;
		return (lat: number, lon: number) => demEleAt(g, lat, lon);
	});

	// Static per grid: the UV-space clip triangles. Per frame: the affine
	// transforms. Per yaw quadrant: the painter traversal order.
	const clipTriangles = $derived(
		terrainActive && demGrid ? buildClipTriangles(demGrid.w - 1, demGrid.h - 1) : []
	);
	const terrainMesh = $derived(
		terrainActive && demGrid ? buildTerrainMesh(demGrid, project) : []
	);
	const terrainOrder = $derived(
		terrainActive && demGrid ? terrainDrawOrder(demGrid.w - 1, demGrid.h - 1, yaw) : []
	);
	const terrainFaces = $derived(
		terrainActive && demGrid && refFrame
			? buildTerrainBlockFaces(demGrid, refFrame, project, BLOCK_DEPTH_M)
			: []
	);

	// Map the snapshot's lat/lon corners onto the rotated ground plane and
	// derive the affine transform that places the image as the right
	// parallelogram. Orthographic projection means a planar rectangle stays
	// a parallelogram under any rotation, so an affine matrix is sufficient.
	const tileTransform = $derived(buildTileTransform(tileImage, refFrame, project));
	const tileOpacity = $derived(tileFadeOpacity(pitch));
	const blockFaces = $derived(buildBlockFaces(tileImage, refFrame, project, BLOCK_DEPTH_M));

	const projectedPoints = $derived(renderSliced.map((p) => project3d(p)));

	// Terrain occlusion: a per-point visibility mask (visibility.ts —
	// view-ray march over the DEM, conservative + smoothed). The route
	// still draws ON TOP of the mesh; hidden stretches are simply omitted
	// (no ghost). Recomputes per camera change, not per hover.
	const visMask = $derived.by(() => {
		const g = demGrid;
		if (!terrainActive || !g) return null;
		return computeVisibility(renderSliced, g, { yaw, pitch, zExaggeration });
	});
	const visibleAt = $derived.by(() => {
		const mask = visMask;
		if (!mask) return undefined;
		const pts = renderSliced;
		return (distM: number) => visibleAtDist(pts, mask, distM);
	});

	const shadowPoints = $derived(buildShadowPoints(renderSliced, refFrame, project, groundEleAt));
	const anchorLines = $derived(
		buildAnchorLines(
			renderFull,
			startDistM,
			endDistM,
			refFrame,
			project,
			ANCHOR_STEP_M,
			groundEleAt,
			visibleAt
		)
	);
	const boundaryAnchors = $derived(
		buildBoundaryAnchors(renderFull, bins, refFrame, project, theme, groundEleAt, visibleAt)
	);
	const polylines = $derived(
		buildPolylineRuns(renderSliced, projectedPoints, bins, refFrame, theme, visMask ?? undefined)
	);
	// Route points whose screen position falls on a FRONT block wall. The
	// walls aren't terrain, so the visibility mask can't know about them —
	// but the camera is always outside the block, so every route point
	// overlapping a front wall is behind it.
	const wallCovered = $derived.by(() => {
		const fronts = terrainFaces.filter((f) => f.isFront);
		if (!terrainActive || fronts.length === 0) return null;
		return projectedPoints.map(([x, y]) =>
			fronts.some((f) => pointInPolygon(x, y, f.verts))
		);
	});
	// Ghost: everything the viewer can't see solid — stretches behind real
	// terrain (mask) plus stretches behind the block walls — drawn at low
	// opacity ABOVE the walls, so both terrain and solid earth read as
	// see-through for the ghost while the solid route stays swallowed.
	// The include-flags are dilated by one point so ghost runs share their
	// boundary point with the solid runs and the line reads continuous as
	// it dives behind a ridge.
	const ghostPolylines = $derived.by(() => {
		const mask = visMask;
		if (!mask) return [];
		const hidden = mask.map((v, i) => !v || (wallCovered?.[i] ?? false));
		const include = hidden.map(
			(h, i) => h || (hidden[i - 1] ?? false) || (hidden[i + 1] ?? false)
		);
		if (!include.some(Boolean)) return [];
		return buildPolylineRuns(renderSliced, projectedPoints, bins, refFrame, theme, include);
	});

	const startEnd = $derived.by(() => {
		if (projectedPoints.length < 2) return null;
		return {
			a: visMask && !visMask[0] ? null : projectedPoints[0],
			b: visMask && !visMask[visMask.length - 1] ? null : projectedPoints[projectedPoints.length - 1]
		};
	});

	const externalHoverHighlight = $derived(
		buildHoverHighlight(
			externalHoverDistM,
			bins,
			renderFull,
			renderSliced,
			refFrame,
			project,
			theme,
			groundEleAt
		)
	);
	const allDrapes = $derived(
		showAllDrapes
			? buildAllDrapes(bins, renderFull, renderSliced, refFrame, project, theme, groundEleAt)
			: []
	);

	// Viewport (visible window in viewBox space).
	let viewport = $state<Viewport | null>(null);

	$effect(() => {
		if (viewport == null && refFrame != null) {
			viewport = defaultViewport(dimensions);
		}
	});

	const isZoomed = $derived(isZoomedOrPanned(viewport, dimensions));
	const isRotated = $derived(yaw !== 0 || pitch !== 0);
	const isViewModified = $derived(isZoomed || isRotated);

	// ---- Canvas painter -------------------------------------------------
	// The scene is the SVG template's paint order reified as data
	// (scene.ts, tested); renderScene (paint.ts) executes it. buildScene
	// consumes the deriveds above so each keeps its own recompute cadence.
	// The hover marker is deliberately NOT in the scene — it's appended at
	// paint time so a pointermove doesn't rebuild the ~1000-op list.
	const sceneOps = $derived(
		buildScene({
			stroke: STROKE,
			terrainActive,
			hasGroundTexture: !!groundTexture,
			terrainOpacity,
			showMap,
			tileOpacity,
			hasTileImage: !!tileImage,
			tileTransform,
			clipTriangles,
			terrainMesh,
			terrainOrder,
			terrainFaces,
			blockFaces,
			shadow: shadowPoints,
			allDrapes,
			externalHover: externalHoverHighlight,
			showAnchorLines,
			anchorLines,
			boundaryAnchors,
			polylines,
			ghostPolylines,
			startEnd
		})
	);

	// Device pixel ratio as state so monitor moves re-render crisply. The
	// matchMedia listener must be re-armed per value (the query names the
	// current ratio).
	let dpr = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio);
	let dprCleanup: (() => void) | null = null;
	function armDprListener() {
		dprCleanup?.();
		const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		const onChange = () => {
			dpr = window.devicePixelRatio;
			armDprListener();
		};
		mq.addEventListener('change', onChange, { once: true });
		dprCleanup = () => mq.removeEventListener('change', onChange);
	}

	const meshCache = createMeshCache();
	let repaintFrame: number | null = null;

	function hoverMarkerOp(): SceneOp | null {
		if (!hoverInfo) return null;
		// renderFull, not points: the dot must ride the terrain-displaced
		// route. The tooltip keeps GPS elevation from `points`.
		const ip = findPointAtDistance(renderFull, hoverInfo.distM);
		const [hx, hy] = project(ip.lat, ip.lon, ip.ele);
		return {
			kind: 'circle',
			cx: hx,
			cy: hy,
			r: STROKE * 1.4,
			fill: '#111827',
			stroke: '#ffffff',
			strokeWidth: 2
		};
	}

	function paint() {
		const canvas = canvasEl;
		if (!canvas) return;
		// CSS size from reactive state, not layout reads: width tracks the
		// wrapper, height is the user height or the data aspect.
		const cssW = wrapperWidth;
		const cssH = userHeight ?? (dimensions.W > 0 ? (cssW * dimensions.H) / dimensions.W : 0);
		if (cssW <= 0 || cssH <= 0) return;
		const devW = Math.max(1, Math.round(cssW * dpr));
		const devH = Math.max(1, Math.round(cssH * dpr));
		if (canvas.width !== devW) canvas.width = devW;
		if (canvas.height !== devH) canvas.height = devH;
		const view = computeViewTransform(viewport, dimensions, cssW, cssH, dpr);
		if (!view) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const marker = hoverMarkerOp();
		renderScene(
			ctx,
			marker ? [...sceneOps, marker] : sceneOps,
			view,
			{ ground: groundTexture?.source, tile: tileImage?.source },
			meshCache
		);
	}

	// rAF-coalesced repaints. The effect only TOUCHES its dependencies;
	// paint() re-reads the deriveds at rAF time ($derived laziness keeps
	// them fresh, and reads outside the effect are untracked) — never
	// snapshot here and hand to the frame, or a state change between
	// effect-run and rAF would paint stale data while the coalescing flag
	// suppresses the reschedule.
	function scheduleRepaint() {
		if (repaintFrame !== null) return;
		repaintFrame = requestAnimationFrame(() => {
			repaintFrame = null;
			paint();
		});
	}

	$effect(() => {
		if (!canvasEl) return;
		/* eslint-disable @typescript-eslint/no-unused-expressions */
		sceneOps;
		hoverInfo;
		viewport;
		dimensions;
		wrapperWidth;
		userHeight;
		groundTexture;
		tileImage;
		dpr;
		/* eslint-enable @typescript-eslint/no-unused-expressions */
		scheduleRepaint();
	});
	// ---------------------------------------------------------------------

	function resetView(e?: Event) {
		e?.stopPropagation();
		viewport = defaultViewport(dimensions);
		yaw = 0;
		pitch = 0;
	}

	function onWheel(e: WheelEvent) {
		if (!canvasEl || !viewport) return;
		e.preventDefault();
		const rect = surfaceRect();
		if (!rect || rect.width <= 0 || rect.height <= 0) return;
		const relX = (e.clientX - rect.left) / rect.width;
		const relY = (e.clientY - rect.top) / rect.height;
		viewport = applyZoomAtCursor(viewport, dimensions, relX, relY, e.deltaY);
	}

	type DragMode = 'pan' | 'rotate';
	let isDragging = false;
	let dragMode: DragMode = 'pan';
	let dragStart: {
		clientX: number;
		clientY: number;
		vp: { x: number; y: number; w: number; h: number };
		yaw: number;
		pitch: number;
	} | null = null;
	let dragMoved = false;

	function isRotateModifier(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
		return e.ctrlKey || e.metaKey;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0 || !viewport) return;
		// Ctrl/Cmd on pointerdown opens contextmenu by default on some platforms;
		// preventDefault keeps our handler in control.
		if (isRotateModifier(e)) e.preventDefault();
		// Freeze any in-flight toggle animation so the drag takes over from the
		// current values rather than racing rAF for pitch/yaw.
		cancelToggleAnim();
		invalidateRects();
		isDragging = true;
		dragMode = isRotateModifier(e) ? 'rotate' : 'pan';
		dragStart = {
			clientX: e.clientX,
			clientY: e.clientY,
			vp: { ...viewport },
			yaw,
			pitch
		};
		dragMoved = false;
		hoverInfo = null;
		document.addEventListener('pointermove', onDocPointerMove);
		document.addEventListener('pointerup', onDocPointerUp);
	}

	function onDocPointerMove(e: PointerEvent) {
		if (!isDragging || !dragStart || !canvasEl || !viewport) return;
		const dx = e.clientX - dragStart.clientX;
		const dy = e.clientY - dragStart.clientY;
		if (!dragMoved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
			dragMoved = true;
			document.body.style.cursor = dragMode === 'rotate' ? 'move' : 'grabbing';
		}
		if (!dragMoved) return;

		if (dragMode === 'rotate') {
			yaw = dragStart.yaw + dx * YAW_PER_PX;
			pitch = Math.max(0, Math.min(PITCH_MAX, dragStart.pitch + dy * PITCH_PER_PX));
			return;
		}
		const rect = surfaceRect();
		if (!rect || rect.width <= 0) return;
		const dxSvg = dx * (dragStart.vp.w / rect.width);
		const dySvg = dy * (dragStart.vp.h / rect.height);
		const newX = dragStart.vp.x - dxSvg;
		const newY = dragStart.vp.y - dySvg;
		viewport = clampViewport(
			{ x: newX, y: newY, w: dragStart.vp.w, h: dragStart.vp.h },
			dimensions
		);
	}

	function onDocPointerUp() {
		if (!isDragging) return;
		document.removeEventListener('pointermove', onDocPointerMove);
		document.removeEventListener('pointerup', onDocPointerUp);
		isDragging = false;
		document.body.style.cursor = '';
		dragStart = null;
		dragMoved = false;
	}

	let isResizing = false;
	let resizeStart: { clientY: number; height: number } | null = null;

	function onResizeDown(e: PointerEvent) {
		if (e.button !== 0 || !wrapperEl) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = wrapperEl.getBoundingClientRect();
		isResizing = true;
		resizeStart = { clientY: e.clientY, height: rect.height };
		document.body.style.cursor = 'nwse-resize';
		document.addEventListener('pointermove', onResizeMove);
		document.addEventListener('pointerup', onResizeUp);
	}

	function onResizeMove(e: PointerEvent) {
		if (!isResizing || !resizeStart) return;
		const dy = e.clientY - resizeStart.clientY;
		userHeight = Math.max(
			USER_HEIGHT_MIN,
			Math.min(USER_HEIGHT_MAX, resizeStart.height + dy)
		);
	}

	function onResizeUp() {
		if (!isResizing) return;
		document.removeEventListener('pointermove', onResizeMove);
		document.removeEventListener('pointerup', onResizeUp);
		isResizing = false;
		resizeStart = null;
		document.body.style.cursor = '';
	}

	let hoverInfo = $state<{ distM: number; cursorX: number; cursorY: number } | null>(
		null
	);

	$effect(() => {
		hoverDistM = hoverInfo?.distM ?? null;
	});

	function binAtDist(distM: number): GradeBin | null {
		for (const b of bins) {
			if (distM >= b.startM && distM <= b.endM) return b;
		}
		return null;
	}

	function onWrapperPointerMove(e: PointerEvent) {
		if (isDragging) return;
		if (!canvasEl || !wrapperEl || !viewport || projectedPoints.length < 2) return;
		const svgR = surfaceRect();
		const wrapR = wrapRect();
		if (!svgR || !wrapR || svgR.width <= 0) return;
		const relX = (e.clientX - svgR.left) / svgR.width;
		const relY = (e.clientY - svgR.top) / svgR.height;
		const svgX = viewport.x + relX * viewport.w;
		const svgY = viewport.y + relY * viewport.h;

		// Find the closest point on the polyline (not just the closest vertex)
		// so the marker and tooltip track the route at sub-vertex precision.
		let bestSeg = -1;
		let bestT = 0;
		let bestDist = Infinity;
		for (let i = 0; i < projectedPoints.length - 1; i++) {
			const [ax, ay] = projectedPoints[i];
			const [bx, by] = projectedPoints[i + 1];
			const dx = bx - ax;
			const dy = by - ay;
			const len2 = dx * dx + dy * dy;
			let t = 0;
			let px = ax;
			let py = ay;
			if (len2 > 1e-9) {
				t = Math.max(0, Math.min(1, ((svgX - ax) * dx + (svgY - ay) * dy) / len2));
				px = ax + t * dx;
				py = ay + t * dy;
			}
			const d = Math.hypot(px - svgX, py - svgY);
			if (d < bestDist) {
				bestDist = d;
				bestSeg = i;
				bestT = t;
			}
		}
		const svgPerPx = viewport.w / svgR.width;
		const thresholdSvg = HOVER_PX * svgPerPx;
		if (bestSeg >= 0 && bestDist <= thresholdSvg) {
			const a = slicedPoints[bestSeg];
			const b = slicedPoints[bestSeg + 1];
			const distM = a.cumDistM + bestT * (b.cumDistM - a.cumDistM);
			hoverInfo = {
				distM,
				cursorX: e.clientX - wrapR.left,
				cursorY: e.clientY - wrapR.top
			};
		} else {
			hoverInfo = null;
		}
	}

	function onWrapperPointerLeave() {
		if (!isDragging) hoverInfo = null;
		// Re-read the rect on the next enter — layout above the widget may have
		// shifted while the pointer was away.
		invalidateRects();
	}

	onMount(() => {
		wrapperEl?.addEventListener('wheel', onWheel, { passive: false });
		// Any scroll (capture: also catches scrollable ancestors) or window
		// resize moves the cached rect; drop it so the next read is fresh.
		window.addEventListener('scroll', invalidateRects, { capture: true, passive: true });
		window.addEventListener('resize', invalidateRects, { passive: true });
		dpr = window.devicePixelRatio;
		armDprListener();
	});

	onDestroy(() => {
		wrapperEl?.removeEventListener('wheel', onWheel);
		window.removeEventListener('scroll', invalidateRects, { capture: true });
		window.removeEventListener('resize', invalidateRects);
		document.removeEventListener('pointermove', onDocPointerMove);
		document.removeEventListener('pointerup', onDocPointerUp);
		document.removeEventListener('pointermove', onResizeMove);
		document.removeEventListener('pointerup', onResizeUp);
		if (vertHideTimer) clearTimeout(vertHideTimer);
		if (terrainHideTimer) clearTimeout(terrainHideTimer);
		if (mapMenuHideTimer) clearTimeout(mapMenuHideTimer);
		cancelToggleAnim();
		if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
		dprCleanup?.();
		document.body.style.cursor = '';
	});

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={wrapperEl}
	bind:clientWidth={wrapperWidth}
	class="relative select-none bg-neutral-100"
	style:height={userHeight ? `${userHeight}px` : undefined}
	oncontextmenu={(e) => e.preventDefault()}
	onpointerdown={onPointerDown}
	onpointermove={onWrapperPointerMove}
	onpointerleave={onWrapperPointerLeave}
>
	<!-- The painter: one bitmap, repainted per frame from the scene ops
	     (paint order lives in scene.ts, locked by its tests). CSS
	     aspect-ratio gives the element its data-derived intrinsic aspect;
	     the backing store is sized in paint() (CSS px × devicePixelRatio). -->
	<canvas
		bind:this={canvasEl}
		class="block w-full"
		class:h-full={!!userHeight}
		style:aspect-ratio={userHeight ? undefined : `${dimensions.W} / ${dimensions.H}`}
	></canvas>

	<div
		class="pointer-events-none absolute left-2 top-2 z-30 rounded-md bg-white/90 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-600 shadow-sm"
	>
		Topo
	</div>

	{#if isViewModified}
		<button
			type="button"
			onpointerdown={(e) => e.stopPropagation()}
			onclick={resetView}
			class="absolute right-2 top-2 z-30 rounded-md bg-white/90 px-2 py-1 text-[11px] font-medium text-neutral-600 shadow-sm hover:bg-white hover:text-neutral-900"
			aria-label="Reset view"
		>
			Reset view
		</button>
	{/if}

	{#snippet sourceIcon(source: MapSource)}
		<svg
			viewBox="0 0 24 24"
			class="h-4 w-4"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			{#if source === 'osm'}
				<path d="M 3 5 L 9 2 L 15 5 L 21 2 L 21 17 L 15 20 L 9 17 L 3 20 Z" />
				<path d="M 9 2 L 9 17" />
				<path d="M 15 5 L 15 20" />
			{:else if source === 'topo'}
				<path d="M 16 3 Q 16 5 17.5 6 Q 18 7.5 21 8" />
				<path d="M 12 3 Q 11.5 6 14 8 Q 17 9.5 21 12" />
				<path d="M 8 3 Q 8 7 12 10 Q 16.5 13 21 16" />
				<path d="M 4 4 Q 2 8 7 10 Q 9 12 11 14 Q 15 16 17 18 Q 19 19 21 20" />
				<path d="M 3 13 Q 3 15 4 16 Q 6 17 8 18 Q 11 19 14 20" />
			{:else if source === 'sat'}
				<g transform="rotate(-45 8 8)">
					<rect x="2" y="7" width="6" height="6" rx="1.5" />
					<rect x="8" y="4" width="4" height="12" rx="1" />
					<rect x="12" y="7" width="6" height="6" rx="1.5" />
				</g>
				<path d="M 17 12 a 3 3 0 0 1 -3 3" />
				<path d="M 20 12 a 6 6 0 0 1 -6 6" />
				<path d="M 23 12 a 9 9 0 0 1 -9 9" />
			{:else}
				<path d="M 5 6 L 19 4 L 20 18 L 6 20 Z" />
				<circle cx="5" cy="6" r="1.6" fill="currentColor" stroke="none" />
				<circle cx="19" cy="4" r="1.6" fill="currentColor" stroke="none" />
				<circle cx="20" cy="18" r="1.6" fill="currentColor" stroke="none" />
				<circle cx="6" cy="20" r="1.6" fill="currentColor" stroke="none" />
			{/if}
		</svg>
	{/snippet}

	<div
		onpointerdown={(e) => e.stopPropagation()}
		class="absolute bottom-2 left-2 z-30 flex items-center gap-0.5 rounded-md bg-white/90 px-1 py-0.5 shadow-sm"
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="relative" onpointerenter={openMapMenu} onpointerleave={closeMapMenu}>
			<button
				type="button"
				onclick={() => (showMap = !showMap)}
				class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {showMap
					? 'text-neutral-800'
					: 'text-neutral-300'}"
				aria-label="Toggle map"
				aria-pressed={showMap}
				title={showMap ? 'Hide map' : 'Show map'}
			>
				{@render sourceIcon(mapSource)}
			</button>
			{#if showMapMenu}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					onpointerenter={openMapMenu}
					onpointerleave={closeMapMenu}
					class="absolute bottom-full left-[-0.25rem] mb-1 flex gap-0.5 rounded-md bg-white px-1 py-0.5 shadow-lg ring-1 ring-neutral-200"
				>
					{#each SOURCES as src (src)}
						<button
							type="button"
							onclick={() => (mapSource = src)}
							class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {mapSource ===
							src
								? 'text-neutral-800'
								: 'text-neutral-300'}"
							aria-label={TILE_SOURCES[src].label}
							aria-pressed={mapSource === src}
							title={TILE_SOURCES[src].label}
						>
							{@render sourceIcon(src)}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div
		onpointerdown={(e) => e.stopPropagation()}
		class="absolute bottom-2 right-2 z-30 flex items-center gap-0.5 rounded-md bg-white/90 px-1 py-0.5 shadow-sm"
	>
		{#if is3D}
			<button
				type="button"
				onclick={() => (showAllDrapes = !showAllDrapes)}
				class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {showAllDrapes
					? 'text-neutral-800'
					: 'text-neutral-300'}"
				aria-label="Toggle drapes"
				aria-pressed={showAllDrapes}
				title={showAllDrapes ? 'Hide drapes' : 'Show drapes'}
			>
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linejoin="round"
					stroke-linecap="round"
				>
					<path
						d="M 3 19 L 3 12 Q 6 7, 10 11 Q 13 14, 16 8 Q 19 4, 21 7 L 21 19 Z"
						fill="currentColor"
						fill-opacity="0.25"
					/>
				</svg>
			</button>
			<button
				type="button"
				onclick={() => (showAnchorLines = !showAnchorLines)}
				class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {showAnchorLines
					? 'text-neutral-800'
					: 'text-neutral-300'}"
				aria-label="Toggle anchor lines"
				aria-pressed={showAnchorLines}
				title={showAnchorLines ? 'Hide anchor lines' : 'Show anchor lines'}
			>
				<svg
					viewBox="0 0 24 24"
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
				>
					<circle cx="12" cy="6.5" r="2.6" fill="currentColor" stroke="none" />
					<line x1="12" y1="9.5" x2="12" y2="20" stroke-dasharray="2.4 2" />
				</svg>
			</button>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative"
				onpointerenter={openTerrainPopover}
				onpointerleave={closeTerrainPopover}
			>
				<button
					type="button"
					onclick={() => (terrainOn = !terrainOn)}
					class="flex h-7 w-7 items-center justify-center rounded hover:bg-neutral-100 {terrainOn
						? 'text-neutral-800'
						: 'text-neutral-300'}"
					aria-label="Toggle terrain"
					aria-pressed={terrainOn}
					title={terrainOn ? 'Flatten ground' : 'Show terrain'}
				>
					<svg
						viewBox="0 0 24 24"
						class="h-4 w-4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="m8 3 4 8 5-5 5 15H2L8 3z" />
					</svg>
				</button>
				{#if showTerrainPopover && terrainOn}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onpointerenter={openTerrainPopover}
						onpointerleave={closeTerrainPopover}
						class="absolute bottom-full right-0 mb-1 flex flex-col gap-2 rounded-md bg-white px-3 py-2 shadow-lg ring-1 ring-neutral-200"
					>
						<label class="flex items-center gap-2 text-[10px] font-medium text-neutral-600">
							<span class="w-10">Float</span>
							<input
								type="range"
								min="0"
								max="50"
								step="1"
								bind:value={floatM}
								class="w-28 accent-neutral-900"
								aria-label="Route float height above terrain"
							/>
							<span class="w-8 text-right tabular-nums">{floatM}m</span>
						</label>
						<label class="flex items-center gap-2 text-[10px] font-medium text-neutral-600">
							<span class="w-10">Opacity</span>
							<input
								type="range"
								min="0.2"
								max="1"
								step="0.05"
								bind:value={terrainOpacity}
								class="w-28 accent-neutral-900"
								aria-label="Terrain opacity"
							/>
							<span class="w-8 text-right tabular-nums">{Math.round(terrainOpacity * 100)}%</span>
						</label>
					</div>
				{/if}
			</div>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative"
				onpointerenter={openVert}
				onpointerleave={closeVert}
			>
				<button
					type="button"
					class="flex h-7 w-7 items-center justify-center rounded text-[10px] font-semibold tabular-nums text-neutral-800 hover:bg-neutral-100"
					aria-label="Vertical exaggeration"
					title="Vertical exaggeration"
				>
					{zExaggeration % 1 === 0 ? `${zExaggeration}×` : `${zExaggeration.toFixed(1)}×`}
				</button>
				{#if showVertPopover}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						onpointerenter={openVert}
						onpointerleave={closeVert}
						class="absolute bottom-full right-0 mb-1 flex justify-center rounded-md bg-white px-2 py-2 shadow-lg ring-1 ring-neutral-200"
					>
						<input
							type="range"
							min="1"
							max="10"
							step="0.5"
							bind:value={zExaggeration}
							style="writing-mode: vertical-lr; direction: rtl;"
							class="h-28 w-4 accent-neutral-900"
							aria-label="Vertical exaggeration"
						/>
					</div>
				{/if}
			</div>
		{/if}
		<button
			type="button"
			onclick={toggle3D}
			class="flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold tabular-nums text-neutral-800 hover:bg-neutral-100"
			aria-label={is3D ? 'Switch to 2D' : 'Switch to 3D'}
			title={is3D ? 'Switch to 2D' : 'Switch to 3D'}
		>
			{is3D ? '3D' : '2D'}
		</button>
	</div>

	{#if hoverInfo}
		{@const p = findPointAtDistance(points, hoverInfo.distM)}
		{@const bin = binAtDist(hoverInfo.distM)}
		{@const distAlong = hoverInfo.distM - startDistM}
		{@const halfW = HOVER_GRADE_WINDOW_M / 2}
		{@const wA = findPointAtDistance(points, hoverInfo.distM - halfW)}
		{@const wB = findPointAtDistance(points, hoverInfo.distM + halfW)}
		{@const wRun = wB.cumDistM - wA.cumDistM}
		{@const localGrade = wRun > 0 ? ((wB.ele - wA.ele) / wRun) * 100 : 0}
		<div
			class="pointer-events-none absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-1.5 whitespace-nowrap rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg"
			style:left="{hoverInfo.cursorX}px"
			style:top="{hoverInfo.cursorY - 12}px"
		>
			<span class="tabular-nums">{fmtKm(distAlong)}</span>
			<span class="text-neutral-500">·</span>
			<span class="tabular-nums">{fmtM(p.ele)}</span>
			{#if bin}
				<span class="text-neutral-500">·</span>
				<span class="flex items-center gap-1">
					<span
						class="inline-block h-2 w-2 rounded-full"
						style:background-color={gradeColor(bin.grade, theme)}
					></span>
					<span class="tabular-nums">{bin.grade.toFixed(1)}%</span>
					{#if wRun > 0}
						<span class="tabular-nums text-neutral-400">({localGrade.toFixed(1)}%)</span>
					{/if}
				</span>
			{/if}
		</div>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		role="separator"
		aria-label="Resize map"
		onpointerdown={onResizeDown}
		class="absolute bottom-0 right-0 z-30 h-4 w-4 cursor-nwse-resize text-neutral-500 hover:text-neutral-800"
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 16 16"
			class="h-full w-full"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
		>
			<line x1="14" y1="6" x2="6" y2="14" />
			<line x1="14" y1="11" x2="11" y2="14" />
		</svg>
	</div>
</div>
