<script lang="ts">
	// Throwaway gallery for the branding/ assets — not linked from anywhere.
	// Sizing/layout uses scoped styles instead of Tailwind: a long-running dev
	// server doesn't always pick up novel utility classes from new files.
	import logo from '../../../branding/klym-logo.svg?raw';
	import outlineWhite from '../../../branding/klym-logo-outline-white.svg?raw';
	import outlineBlack from '../../../branding/klym-logo-outline-black.svg?raw';
	import filledOutlineWhite from '../../../branding/klym-logo-filled-outline-white.svg?raw';
	import filledOutlineBlack from '../../../branding/klym-logo-filled-outline-black.svg?raw';
	import shadow from '../../../branding/klym-logo-shadow.svg?raw';
	import wordmark from '../../../branding/klym-wordmark.svg?raw';
	import wordmarkGradient from '../../../branding/klym-wordmark-gradient.svg?raw';

	const marks = [
		{ name: 'klym-logo.svg', svg: logo },
		{ name: 'klym-logo-shadow.svg', svg: shadow },
		{ name: 'klym-logo-outline-white.svg', svg: outlineWhite },
		{ name: 'klym-logo-outline-black.svg', svg: outlineBlack },
		{ name: 'klym-logo-filled-outline-white.svg', svg: filledOutlineWhite },
		{ name: 'klym-logo-filled-outline-black.svg', svg: filledOutlineBlack }
	];
	const words = [
		{ name: 'klym-wordmark.svg', svg: wordmark },
		{ name: 'klym-wordmark-gradient.svg', svg: wordmarkGradient }
	];

	const surfaces = [
		{ label: 'Light', dark: false },
		{ label: 'Dark', dark: true }
	];
</script>

<svelte:head>
	<title>branding — klym</title>
</svelte:head>

<div class="page">
	<h1>Branding assets</h1>
	<p class="sub">Throwaway preview of <code>branding/</code> — each asset on light and dark.</p>

	{#each surfaces as surface}
		<h2>{surface.label}</h2>
		<div class="grid">
			{#each marks as asset}
				<figure class:dark={surface.dark}>
					<div class="mark">{@html asset.svg}</div>
					<figcaption>{asset.name}</figcaption>
				</figure>
			{/each}
			{#each words as asset}
				<figure class="wide" class:dark={surface.dark}>
					<div class="word">{@html asset.svg}</div>
					<figcaption>{asset.name}</figcaption>
				</figure>
			{/each}
		</div>
	{/each}
</div>

<style>
	.page {
		max-width: 64rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem;
	}
	h1 {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--color-neutral-900);
	}
	.sub {
		margin-top: 0.25rem;
		font-size: 0.875rem;
		color: var(--color-neutral-500);
	}
	h2 {
		margin: 2rem 0 0.75rem;
		font-size: 0.875rem;
		font-weight: 500;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-neutral-400);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;
	}
	@media (min-width: 768px) {
		.grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	figure {
		margin: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		border-radius: 0.75rem;
		padding: 1.5rem;
		background: var(--color-neutral-50);
		border: 1px solid var(--color-neutral-200);
	}
	figure.dark {
		background: var(--color-neutral-900);
		border-color: var(--color-neutral-900);
	}
	figure.wide {
		grid-column: 1 / -1;
	}
	@media (min-width: 768px) {
		figure.wide {
			grid-column: span 3;
		}
	}
	.mark {
		width: 6rem;
		height: 6rem;
	}
	.word {
		width: 100%;
		height: 4rem;
	}
	.mark :global(svg),
	.word :global(svg) {
		width: 100%;
		height: 100%;
	}
	figcaption {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-neutral-500);
	}
	figure.dark figcaption {
		color: var(--color-neutral-400);
	}
</style>
