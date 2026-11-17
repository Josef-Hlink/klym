// A chart's hover, made to work under a finger as well as a mouse (the same
// action forj uses). Put it on the element whose pointer position drives the
// readout and hand it what that element did on pointermove/pointerleave:
//
//   use:scrub={{ move: (e) => …, leave: () => (hover = null) }}
//
// - A tap reads the point under it (a touch fires no pointermove for a tap,
//   so pointerdown reads too), and a sideways drag scrubs: touch-action
//   pan-y keeps vertical swipes scrolling the page and hands horizontal ones
//   to the chart.
// - Lifting the finger keeps the reading where it was (a touch's
//   pointerleave fires on lift; a mouse's means it left), and a touch
//   anywhere outside the chart clears it. A vertical swipe that the browser
//   takes over for scrolling (pointercancel) clears it too.
// - The chart's text never selects and a long press raises no callout.
export type ScrubOptions = {
	move: (e: PointerEvent) => void;
	leave: () => void;
};

export function scrub(node: HTMLElement | SVGElement, options: ScrubOptions) {
	let opts = options;
	let held = false;
	const style = (node as HTMLElement).style;
	style.setProperty('touch-action', 'pan-y');
	style.setProperty('user-select', 'none');
	style.setProperty('-webkit-user-select', 'none');
	style.setProperty('-webkit-touch-callout', 'none');

	const move = (e: PointerEvent) => {
		if (e.pointerType === 'touch') {
			if (!e.isPrimary) return;
			held = true;
			// A touch is captured by what it landed on; let go so pointermove
			// keeps reporting real positions while the finger crosses children.
			if (e.type === 'pointerdown') {
				const t = e.target as Element | null;
				if (t?.hasPointerCapture?.(e.pointerId)) t.releasePointerCapture(e.pointerId);
			}
		}
		opts.move(e);
	};
	const leave = (e: PointerEvent) => {
		if (e.pointerType !== 'touch') opts.leave();
	};
	const cancel = () => {
		held = false;
		opts.leave();
	};
	const outside = (e: PointerEvent) => {
		if (held && !node.contains(e.target as Node)) {
			held = false;
			opts.leave();
		}
	};
	node.addEventListener('pointerdown', move as EventListener);
	node.addEventListener('pointermove', move as EventListener);
	node.addEventListener('pointerleave', leave as EventListener);
	node.addEventListener('pointercancel', cancel);
	document.addEventListener('pointerdown', outside, true);
	return {
		update: (o: ScrubOptions) => (opts = o),
		destroy: () => {
			node.removeEventListener('pointerdown', move as EventListener);
			node.removeEventListener('pointermove', move as EventListener);
			node.removeEventListener('pointerleave', leave as EventListener);
			node.removeEventListener('pointercancel', cancel);
			document.removeEventListener('pointerdown', outside, true);
		}
	};
}

/** True on a device whose primary pointer is a finger. */
export function coarsePointer(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}
