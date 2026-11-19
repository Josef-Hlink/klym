<!--
	The hlink maker's tag: a ribbon end pinned to the left edge, just the
	mark until hovered (or focused, or tapped on a phone), then it unrolls to
	"built by hlink". Self-contained on purpose (scoped CSS, inline mark, no
	Tailwind) so the same file drops into any hlink app. The mark is the small
	cut from hlink/brand (mark --bg none).

	Each app dresses it in its own theme from its global CSS; anything unset
	falls back to hlink's own tokyonight:
		:root {
			--hlink-ribbon-bg: …;    ribbon
			--hlink-ribbon-h: …;     the mark's h, and the link
			--hlink-ribbon-j: …;     the mark's J, and the link on hover
			--hlink-ribbon-text: …;  "built by"
		}

	Where a pinned tab would sit over content it parks instead. Mount one
	roaming ribbon in the root layout; its `park` says when to park:
		phone (default)  under 640px, tailwind's sm
		touch            that, and any device without hover (tablets too)
	Parked, the roaming ribbon drops to the very end of the page. A page can
	offer a better spot with a second <HlinkRibbon parked />: it shows only
	while parking and sits absolutely at the left of its nearest positioned
	ancestor, vertically centred, and the roaming ribbon steps aside. All of
	it is CSS (media queries + :has), so nothing flashes before hydration.
-->
<script lang="ts">
	let { parked = false, park = 'phone' }: { parked?: boolean; park?: 'phone' | 'touch' } =
		$props();
</script>

<aside
	class={[
		'ribbon',
		parked && 'parked hlink-ribbon-parked',
		park === 'touch' && 'hlink-ribbon-touch'
	]}
	tabindex="-1"
	aria-label="built by hlink"
>
	<svg class="mark" viewBox="0 0 512 512" aria-hidden="true">
		<path
			class="h"
			d="M192 503.9C141.7 491 97.4 463.1 64 425.3L64 299Q64 260 79.1 224.2Q93.7 189.8 120.2 163.2Q146.8 136.7 181.2 122.1Q217 107 256 107Q272.3 107 288 109.6L288 213Q288 226.3 278.6 235.6Q277.3 236.9 276 238Q266.6 235 256 235Q229.5 235 210.7 253.7Q192 272.5 192 299ZM320 427.7Q331.8 424.2 343.2 419.4Q383.4 402.3 414.4 371.4Q434 351.8 448 328.5L448 425.3C414.6 463.1 370.3 491 320 503.9ZM192 8.1L192 84.3Q180.2 87.8 168.8 92.6Q128.6 109.7 97.6 140.6Q78 160.2 64 183.5L64 86.7C97.4 48.9 141.7 21 192 8.1Z"
		/>
		<path
			class="j"
			d="M236 274Q245.4 277 256 277Q282.5 277 301.3 258.3Q320 239.5 320 213L320 8.1C370.3 21 414.6 48.9 448 86.7L448 213Q448 252 432.9 287.8Q418.3 322.2 391.8 348.8Q365.2 375.3 330.8 389.9Q295 405 256 405Q239.7 405 224 402.4L224 299Q224 285.7 233.4 276.4Q234.7 275.1 236 274Z"
		/>
	</svg>
	<span class="label"><span>built by <a href="https://hlink.dev">hlink</a></span></span>
</aside>

<style>
	.ribbon {
		--bg: var(--hlink-ribbon-bg, #1a1b26);
		--h: var(--hlink-ribbon-h, #82aaff);
		--j: var(--hlink-ribbon-j, #7dcfff);
		--text: var(--hlink-ribbon-text, #a9b1d6);
		--stitch: rgb(255 255 255 / 0.16);
		--notch: 7px;
		--unroll: 420ms cubic-bezier(0.22, 1, 0.36, 1);

		position: fixed;
		left: 0;
		bottom: calc(20px + env(safe-area-inset-bottom));
		z-index: 40;
		display: flex;
		align-items: center;
		gap: 0;
		height: 26px;
		padding: 0 calc(var(--notch) + 7px) 0 8px;
		background: var(--bg);
		color: var(--text);
		font: 500 11px/1 ui-monospace, 'JetBrains Mono', SFMono-Regular, Menlo, monospace;
		letter-spacing: 0.02em;
		white-space: nowrap;
		/* flush with the screen edge, swallowtail at the free end */
		clip-path: polygon(0 0, 100% 0, calc(100% - var(--notch)) 50%, 100% 100%, 0 100%);
		filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.25));
		cursor: default;
		outline: none;
		user-select: none;
		-webkit-user-select: none;
		transition: gap var(--unroll);
	}

	/* stitching, like a sewn-in label */
	.ribbon::before {
		content: '';
		position: absolute;
		inset: 3px var(--notch) 3px 0;
		border-block: 1px dashed var(--stitch);
		pointer-events: none;
	}

	/* the roll: a curl of shading at the free end that flattens out as the
	   ribbon unrolls */
	.ribbon::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		right: calc(var(--notch) - 1px);
		width: 7px;
		background: linear-gradient(
			90deg,
			rgb(255 255 255 / 0) 0%,
			rgb(255 255 255 / 0.14) 45%,
			rgb(0 0 0 / 0.35) 100%
		);
		pointer-events: none;
		transition: opacity var(--unroll);
	}

	.mark {
		flex: none;
		width: 16px;
		height: 16px;
	}
	.h {
		fill: var(--h);
	}
	.j {
		fill: var(--j);
	}

	/* 0fr -> 1fr: the text is laid out at full width from the start and
	   revealed left to right, so it reads as unrolling rather than growing */
	.label {
		display: grid;
		grid-template-columns: 0fr;
		transition: grid-template-columns var(--unroll);
	}
	.label > span {
		min-width: 0;
		overflow: hidden;
		opacity: 0;
		transition: opacity 200ms ease;
	}

	a {
		color: var(--h);
		text-decoration: none;
	}
	a:hover,
	a:focus-visible {
		color: var(--j);
		text-decoration: underline;
		text-underline-offset: 2px;
		outline: none;
	}

	.ribbon:hover,
	.ribbon:focus-within {
		gap: 8px;
	}
	.ribbon:hover::after,
	.ribbon:focus-within::after {
		opacity: 0;
	}
	.ribbon:hover .label,
	.ribbon:focus-within .label {
		grid-template-columns: 1fr;
	}
	.ribbon:hover .label > span,
	.ribbon:focus-within .label > span {
		opacity: 1;
		transition-delay: 80ms;
	}

	/* parking: see the header. The same three rules twice, once per trigger;
	   `park="touch"` on the layout ribbon flags the whole page via :has. */
	.parked {
		display: none;
	}
	@media (max-width: 639.98px) {
		.ribbon:not(.parked) {
			position: relative;
			bottom: auto;
			width: max-content;
			margin: 8px 0 calc(16px + env(safe-area-inset-bottom));
		}
		:global(body:has(.hlink-ribbon-parked)) .ribbon:not(.parked) {
			display: none;
		}
		.parked {
			display: flex;
			position: absolute;
			left: 0;
			bottom: auto;
			top: 50%;
			translate: 0 -50%;
		}
	}
	@media (hover: none) and (min-width: 640px) {
		:global(body:has(.hlink-ribbon-touch)) .ribbon:not(.parked) {
			position: relative;
			bottom: auto;
			width: max-content;
			margin: 8px 0 calc(16px + env(safe-area-inset-bottom));
		}
		:global(body:has(.hlink-ribbon-touch):has(.hlink-ribbon-parked)) .ribbon:not(.parked) {
			display: none;
		}
		:global(body:has(.hlink-ribbon-touch)) .parked {
			display: flex;
			position: absolute;
			left: 0;
			bottom: auto;
			top: 50%;
			translate: 0 -50%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ribbon,
		.ribbon::after,
		.label,
		.label > span {
			transition: none;
		}
	}

	@media print {
		.ribbon {
			display: none;
		}
	}
</style>
