<script lang="ts">
	import SegmentProfile, { type GradeLabelMode } from '$lib/components/SegmentProfile.svelte';
	import SegmentMap from '$lib/components/SegmentMap.svelte';
	import { computeAdaptiveBins, computeBins, computeCropStats, gradeColor } from '$lib/elevation.js';
	import { fmtKm, fmtM } from '$lib/format.js';
	import type { PageProps } from './$types.js';

	let { data }: PageProps = $props();
	const route = $derived(data.route);
	const segment = $derived(data.segment);

	let binSizeM = $state(500);
	$effect(() => {
		binSizeM = segment.binSizeM;
	});

	type BinMode = 'fixed' | 'adaptive';
	let binMode = $state<BinMode>('fixed');
	let epsilonM = $state(5);

	let mapHoverDistM = $state<number | null>(null);
	let chartHoverDistM = $state<number | null>(null);

	let labelMode = $state<GradeLabelMode>('percent');
	const labelModeOptions: { value: GradeLabelMode; label: string }[] = [
		{ value: 'percent', label: 'n%' },
		{ value: 'number', label: 'n' },
		{ value: 'off', label: 'off' }
	];

	const adaptiveBins = $derived(
		computeAdaptiveBins(route.points, segment.startDistM, segment.endDistM, epsilonM)
	);
	const fixedBins = $derived(
		computeBins(route.points, segment.startDistM, segment.endDistM, binSizeM)
	);
	const activeBins = $derived(binMode === 'adaptive' ? adaptiveBins : fixedBins);

	const stats = $derived.by(() => {
		const base = computeCropStats(route.points, segment.startDistM, segment.endDistM, binSizeM);
		if (binMode === 'fixed') return base;
		let maxGrade = -Infinity;
		let maxGradeBucket = base.maxGradeBucket;
		for (const b of adaptiveBins) {
			if (b.grade > maxGrade) {
				maxGrade = b.grade;
				maxGradeBucket = { startM: b.startM, endM: b.endM };
			}
		}
		if (maxGrade === -Infinity) maxGrade = base.avgGrade;
		return { ...base, maxGrade, maxGradeBucket };
	});

	let svgEl: SVGSVGElement | null = $state(null);
	let exporting = $state(false);
	let exportError = $state<string | null>(null);
	let exportMenuOpen = $state(false);
	let copiedFlash = $state(false);
	let exportMenuEl: HTMLDivElement | null = $state(null);

	$effect(() => {
		if (!exportMenuOpen) return;
		const handler = (e: MouseEvent) => {
			if (exportMenuEl && !exportMenuEl.contains(e.target as Node)) {
				exportMenuOpen = false;
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	});

	function fmtBinLabel(m: number): string {
		return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${m} m`;
	}

	function serializeSvg(svg: SVGSVGElement): string {
		const clone = svg.cloneNode(true) as SVGSVGElement;
		clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		return new XMLSerializer().serializeToString(clone);
	}

	async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
		const xml = serializeSvg(svg);
		const svg64 = btoa(unescape(encodeURIComponent(xml)));
		const src = `data:image/svg+xml;base64,${svg64}`;

		const img = new Image();
		img.crossOrigin = 'anonymous';
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('Failed to load SVG as image'));
			img.src = src;
		});

		const vb = svg.viewBox.baseVal;
		const w = vb.width || svg.clientWidth || 1600;
		const h = vb.height || svg.clientHeight || 800;
		const canvas = document.createElement('canvas');
		canvas.width = w * scale;
		canvas.height = h * scale;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas 2D context unavailable');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob((b) => resolve(b), 'image/png')
		);
		if (!blob) throw new Error('PNG encode failed');
		return blob;
	}

	function triggerDownload(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function savePng() {
		if (!svgEl) return;
		exporting = true;
		exportError = null;
		exportMenuOpen = false;
		try {
			const blob = await svgToPngBlob(svgEl);
			triggerDownload(blob, `${route.id}-${segment.id}.png`);
		} catch (err) {
			exportError = (err as Error).message ?? 'Export failed';
		} finally {
			exporting = false;
		}
	}

	async function copyPng() {
		if (!svgEl) return;
		exporting = true;
		exportError = null;
		exportMenuOpen = false;
		try {
			if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
				throw new Error('Clipboard API not available in this browser');
			}
			const blob = await svgToPngBlob(svgEl);
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			copiedFlash = true;
			setTimeout(() => (copiedFlash = false), 1800);
		} catch (err) {
			exportError = (err as Error).message ?? 'Copy failed';
		} finally {
			exporting = false;
		}
	}

	async function saveSvg() {
		if (!svgEl) return;
		exporting = true;
		exportError = null;
		exportMenuOpen = false;
		try {
			const xml = serializeSvg(svgEl);
			const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
			triggerDownload(blob, `${route.id}-${segment.id}.svg`);
		} catch (err) {
			exportError = (err as Error).message ?? 'Export failed';
		} finally {
			exporting = false;
		}
	}
</script>

<svelte:head>
	<title>{segment.name} · {route.name} · klym</title>
</svelte:head>

<main class="mx-auto max-w-5xl px-6 py-10">
	<a href="/routes/{route.id}" class="text-sm text-neutral-500 hover:text-neutral-900"
		>← {route.name}</a
	>
	<header class="mt-4 mb-6 flex items-end justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{segment.name}</h1>
			<p class="mt-1 text-xs text-neutral-500"><code>{segment.id}</code></p>
		</div>
		<div bind:this={exportMenuEl} class="relative">
			<button
				type="button"
				onclick={() => (exportMenuOpen = !exportMenuOpen)}
				disabled={exporting}
				aria-haspopup="menu"
				aria-expanded={exportMenuOpen}
				class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
			>
				{exporting ? 'Rendering…' : copiedFlash ? 'Copied!' : 'Export'}
				<svg
					class="h-3 w-3"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			{#if exportMenuOpen}
				<div
					role="menu"
					class="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg"
				>
					<button
						type="button"
						role="menuitem"
						onclick={savePng}
						class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
					>
						Save as PNG
					</button>
					<button
						type="button"
						role="menuitem"
						onclick={copyPng}
						class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
					>
						Copy as PNG
					</button>
					<button
						type="button"
						role="menuitem"
						onclick={saveSvg}
						class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
					>
						Save as SVG
					</button>
				</div>
			{/if}
		</div>
	</header>

	<div class="mb-4 rounded-lg border border-neutral-200 bg-white p-4">
		<dl class="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Length</dt>
				<dd class="mt-1 text-lg font-medium">{fmtKm(stats.lengthM)}</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Ascent</dt>
				<dd class="mt-1 text-lg font-medium">+{fmtM(stats.totalAscentM)}</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Net gain</dt>
				<dd class="mt-1 text-lg font-medium">
					{stats.netGainM >= 0 ? '+' : ''}{fmtM(stats.netGainM)}
				</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">Avg grade</dt>
				<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
					<span
						class="inline-block h-3 w-3 rounded"
						style:background-color={gradeColor(stats.avgGrade)}
					></span>
					{stats.avgGrade.toFixed(1)}%
				</dd>
			</div>
			<div>
				<dt class="text-xs uppercase tracking-wide text-neutral-500">
					{binMode === 'adaptive' ? 'Max section' : `Max ${fmtBinLabel(binSizeM)}`}
				</dt>
				<dd class="mt-1 flex items-center gap-2 text-lg font-medium">
					<span
						class="inline-block h-3 w-3 rounded"
						style:background-color={gradeColor(stats.maxGrade)}
					></span>
					{stats.maxGrade.toFixed(1)}%
				</dd>
			</div>
		</dl>
	</div>

	<div class="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-neutral-200 bg-white px-4 py-3">
		<div class="flex items-center gap-2">
			<span class="text-xs font-medium uppercase tracking-wide text-neutral-500">Sections</span>
			<div class="inline-flex overflow-hidden rounded-md border border-neutral-300 text-xs">
				<button
					type="button"
					onclick={() => (binMode = 'fixed')}
					class="px-2.5 py-1 font-medium transition-colors {binMode === 'fixed'
						? 'bg-neutral-900 text-white'
						: 'bg-white text-neutral-600 hover:bg-neutral-100'}"
				>
					Fixed
				</button>
				<button
					type="button"
					onclick={() => (binMode = 'adaptive')}
					class="border-l border-neutral-300 px-2.5 py-1 font-medium transition-colors {binMode ===
					'adaptive'
						? 'bg-neutral-900 text-white'
						: 'bg-white text-neutral-600 hover:bg-neutral-100'}"
				>
					Adaptive
				</button>
			</div>
		</div>
		{#if binMode === 'fixed'}
			<div class="flex flex-1 items-center gap-3 min-w-64">
				<label for="bin-size" class="text-xs font-medium uppercase tracking-wide text-neutral-500">
					Section length
				</label>
				<input
					id="bin-size"
					type="range"
					min="100"
					max="1000"
					step="50"
					bind:value={binSizeM}
					class="flex-1 accent-neutral-900"
				/>
				<span class="w-20 text-right text-sm tabular-nums">{fmtBinLabel(binSizeM)}</span>
			</div>
		{:else}
			<div class="flex flex-1 items-center gap-3 min-w-64">
				<label for="epsilon" class="text-xs font-medium uppercase tracking-wide text-neutral-500">
					Tolerance
				</label>
				<input
					id="epsilon"
					type="range"
					min="1"
					max="25"
					step="1"
					bind:value={epsilonM}
					class="flex-1 accent-neutral-900"
				/>
				<span class="min-w-32 whitespace-nowrap text-right text-sm tabular-nums">±{epsilonM} m · {activeBins.length} sections</span>
			</div>
		{/if}
		<div class="flex items-center gap-2">
			<span class="text-xs font-medium uppercase tracking-wide text-neutral-500">Labels</span>
			<div class="inline-flex overflow-hidden rounded-md border border-neutral-300 text-xs">
				{#each labelModeOptions as opt (opt.value)}
					<button
						type="button"
						onclick={() => (labelMode = opt.value)}
						class="px-2.5 py-1 font-medium transition-colors {labelMode === opt.value
							? 'bg-neutral-900 text-white'
							: 'bg-white text-neutral-600 hover:bg-neutral-100'} {opt.value !== 'percent'
							? 'border-l border-neutral-300'
							: ''}"
					>
						{opt.label}
					</button>
				{/each}
			</div>
		</div>
	</div>

	<div class="overflow-hidden rounded-lg border border-neutral-200 bg-white">
		<SegmentProfile
			bind:svgEl
			bind:hoverDistM={chartHoverDistM}
			points={route.points}
			startDistM={segment.startDistM}
			endDistM={segment.endDistM}
			{binSizeM}
			bins={activeBins}
			{labelMode}
			externalHoverDistM={mapHoverDistM}
			title="klym"
			subtitle="{segment.name} — {route.name}"
		/>
	</div>

	<div class="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white">
		<SegmentMap
			points={route.points}
			startDistM={segment.startDistM}
			endDistM={segment.endDistM}
			bins={activeBins}
			bind:hoverDistM={mapHoverDistM}
			externalHoverDistM={chartHoverDistM}
		/>
	</div>

	{#if exportError}
		<p class="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{exportError}</p>
	{/if}
</main>
