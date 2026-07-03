<script lang="ts">
	import { enhance } from '$app/forms';
	import KlymWordmark from '$lib/components/KlymWordmark.svelte';
	import { fmtKm, fmtM } from '$lib/format.js';
	import type { PageProps } from './$types.js';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);
	let dragging = $state(false);
	let selectedFile = $state<File | null>(null);
	let fileInput: HTMLInputElement | null = $state(null);

	let openMenuId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let editingName = $state('');
	let confirmingId = $state<string | null>(null);
	let rowError = $state<string | null>(null);

	function startRename(id: string, currentName: string) {
		editingName = currentName;
		editingId = id;
		openMenuId = null;
		confirmingId = null;
	}
	function cancelRename() {
		editingId = null;
		editingName = '';
	}
	function startConfirmDelete(id: string) {
		confirmingId = id;
		openMenuId = null;
		editingId = null;
	}
	function cancelDelete() {
		confirmingId = null;
	}

	$effect(() => {
		if (openMenuId === null) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t?.closest('[data-row-menu]')) openMenuId = null;
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	});

	$effect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (editingId !== null) cancelRename();
			else if (confirmingId !== null) cancelDelete();
			else if (openMenuId !== null) openMenuId = null;
		};
		document.addEventListener('keydown', handler);
		return () => document.removeEventListener('keydown', handler);
	});

	function acceptsFile(f: File): boolean {
		return (
			f.name.toLowerCase().endsWith('.gpx') ||
			f.type === 'application/gpx+xml' ||
			f.type === 'application/xml' ||
			f.type === 'text/xml'
		);
	}

	function setFile(f: File | null) {
		if (!f) {
			selectedFile = null;
			if (fileInput) fileInput.value = '';
			return;
		}
		if (!acceptsFile(f)) return;
		selectedFile = f;
		if (fileInput) {
			const dt = new DataTransfer();
			dt.items.add(f);
			fileInput.files = dt.files;
		}
	}

	function onDragEnter(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer?.types.includes('Files')) dragging = true;
	}
	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}
	function onDragLeave(e: DragEvent) {
		if (e.currentTarget === e.target) dragging = false;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const f = e.dataTransfer?.files?.[0];
		if (f) setFile(f);
	}
	function onInputChange(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
		selectedFile = f;
	}

	function fmtBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}
	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleDateString();
	}
</script>

<svelte:head>
	<title>klym</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-6 py-12">
	<header class="mb-10">
		<h1><KlymWordmark class="h-14 w-auto" /></h1>
		<p class="mt-3 text-sm text-neutral-600">
			Upload a GPX, pick two points, get a climbfinder-style profile image.
		</p>
	</header>

	<section class="mb-12">
		<h2 class="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
			Upload route
		</h2>
		<form
			method="POST"
			action="?/upload"
			enctype="multipart/form-data"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			class="space-y-4 rounded-lg border border-neutral-200 bg-white p-5"
		>
			<div>
				<label for="name" class="block text-sm font-medium text-neutral-700">
					Route name
				</label>
				<input
					id="name"
					name="name"
					type="text"
					autocomplete="off"
					placeholder="e.g. Alpe d'Huez loop"
					value={form && form.scope === 'upload' && 'name' in form ? (form.name ?? '') : ''}
					class="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
				/>
				<p class="mt-1 text-xs text-neutral-500">
					Slugified into the route id (e.g. <code>alpe-d-huez-loop</code>). Leave blank to use the file name.
				</p>
			</div>

			<div>
				<span class="block text-sm font-medium text-neutral-700">GPX file</span>
				<label
					for="file"
					ondragenter={onDragEnter}
					ondragover={onDragOver}
					ondragleave={onDragLeave}
					ondrop={onDrop}
					class="mt-1 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors
						{dragging
						? 'border-neutral-900 bg-neutral-50'
						: selectedFile
							? 'border-neutral-400 bg-white'
							: 'border-neutral-300 bg-neutral-50 hover:border-neutral-400 hover:bg-white'}"
				>
					{#if selectedFile}
						<div class="flex items-center gap-3">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								class="h-6 w-6 text-neutral-700"
							>
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<path d="M14 2v6h6" />
							</svg>
							<div class="text-left">
								<div class="text-sm font-medium text-neutral-900">
									{selectedFile.name}
								</div>
								<div class="text-xs text-neutral-500">
									{fmtBytes(selectedFile.size)}
								</div>
							</div>
						</div>
						<button
							type="button"
							onclick={(e) => {
								e.preventDefault();
								setFile(null);
							}}
							class="mt-2 text-xs text-neutral-500 underline hover:text-neutral-900"
						>
							Remove
						</button>
					{:else}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							class="h-8 w-8 text-neutral-400"
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="17 8 12 3 7 8" />
							<line x1="12" y1="3" x2="12" y2="15" />
						</svg>
						<div class="text-sm text-neutral-700">
							<span class="font-medium text-neutral-900">Drop a GPX file here</span>
							or click to browse
						</div>
						<div class="text-xs text-neutral-500">.gpx · up to 15 MB</div>
					{/if}
				</label>
				<input
					bind:this={fileInput}
					id="file"
					name="file"
					type="file"
					accept=".gpx,application/gpx+xml,application/xml,text/xml"
					required
					onchange={onInputChange}
					class="sr-only"
				/>
			</div>

			{#if form && form.scope === 'upload' && 'error' in form && form.error}
				<p class="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
					{form.error}
				</p>
			{/if}

			<button
				type="submit"
				disabled={submitting}
				class="inline-flex items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
			>
				{submitting ? 'Uploading…' : 'Upload'}
			</button>
		</form>
	</section>

	<section>
		<h2 class="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">
			Routes
		</h2>
		{#if data.routes.length === 0}
			<p class="text-sm text-neutral-500">
				No routes yet. Upload one above to get started.
			</p>
		{:else}
			{#if rowError}
				<p class="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{rowError}</p>
			{/if}
			<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each data.routes as route (route.id)}
					<li class="flex items-center hover:bg-neutral-50">
						{#if editingId === route.id}
							<form
								method="POST"
								action="?/renameRoute"
								use:enhance={() => {
									rowError = null;
									return async ({ result, update }) => {
										await update();
										if (result.type === 'success') {
											editingId = null;
											editingName = '';
										} else if (result.type === 'failure') {
											rowError =
												(result.data &&
													typeof result.data.error === 'string' &&
													result.data.error) ||
												'Rename failed';
										}
									};
								}}
								class="flex flex-1 items-center gap-3 px-5 py-3"
							>
								<input type="hidden" name="id" value={route.id} />
								<div class="flex-1">
									<!-- svelte-ignore a11y_autofocus -->
									<input
										name="name"
										type="text"
										autocomplete="off"
										bind:value={editingName}
										autofocus
										required
										class="block w-full rounded-md border border-neutral-300 px-2 py-1 text-sm font-medium focus:border-neutral-900 focus:outline-none"
									/>
									<div class="mt-1 text-xs text-neutral-500">
										<code>{route.id}</code> · {route.pointCount} pts · added {fmtDate(route.createdAt)}
									</div>
								</div>
								<div class="text-right text-sm text-neutral-600">
									<div>{fmtKm(route.totalDistM, 1)}</div>
									<div class="text-xs text-neutral-500">+{fmtM(route.totalAscentM)}</div>
								</div>
								<div class="flex items-center gap-1">
									<button
										type="submit"
										class="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700"
									>Save</button>
									<button
										type="button"
										onclick={cancelRename}
										class="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
									>Cancel</button>
								</div>
							</form>
						{:else}
							<a
								href="/routes/{route.id}"
								class="flex flex-1 items-center justify-between gap-4 px-5 py-4"
							>
								<div>
									<div class="font-medium">{route.name}</div>
									<div class="text-xs text-neutral-500">
										<code>{route.id}</code> · {route.pointCount} pts · added {fmtDate(route.createdAt)}
									</div>
								</div>
								<div class="text-right text-sm text-neutral-600">
									<div>{fmtKm(route.totalDistM, 1)}</div>
									<div class="text-xs text-neutral-500">+{fmtM(route.totalAscentM)}</div>
								</div>
							</a>
							<div data-row-menu class="relative flex items-center pr-3">
								{#if confirmingId === route.id}
									<form
										method="POST"
										action="?/deleteRoute"
										use:enhance={() => {
											rowError = null;
											return async ({ result, update }) => {
												await update();
												if (result.type === 'success') {
													confirmingId = null;
												} else if (result.type === 'failure') {
													rowError =
														(result.data &&
															typeof result.data.error === 'string' &&
															result.data.error) ||
														'Delete failed';
												}
											};
										}}
										class="flex items-center gap-1"
									>
										<input type="hidden" name="id" value={route.id} />
										<button
											type="submit"
											class="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
										>Delete</button>
										<button
											type="button"
											onclick={cancelDelete}
											class="rounded-md px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
										>Cancel</button>
									</form>
								{:else}
									<button
										type="button"
										aria-label="Open route menu"
										aria-haspopup="menu"
										aria-expanded={openMenuId === route.id}
										onclick={() =>
											(openMenuId = openMenuId === route.id ? null : route.id)}
										class="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900"
									>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											viewBox="0 0 24 24"
											fill="currentColor"
											class="h-4 w-4"
											aria-hidden="true"
										>
											<circle cx="12" cy="5" r="1.6" />
											<circle cx="12" cy="12" r="1.6" />
											<circle cx="12" cy="19" r="1.6" />
										</svg>
									</button>
									{#if openMenuId === route.id}
										<div
											role="menu"
											class="absolute right-2 top-full z-10 mt-1 w-32 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg"
										>
											<button
												type="button"
												role="menuitem"
												onclick={() => startRename(route.id, route.name)}
												class="block w-full px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-50"
											>Rename</button>
											<button
												type="button"
												role="menuitem"
												onclick={() => startConfirmDelete(route.id)}
												class="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
											>Delete</button>
										</div>
									{/if}
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</main>
