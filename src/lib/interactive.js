/* ==========================================================================
   Interaction runtime
   --------------------------------------------------------------------------
   minimal.css deliberately flattened the old decorative layer, which left the
   app reading as dead rather than calm. This file adds back the *response* —
   never the decoration:

     · initReveals()  scroll-in for [data-rv] blocks
     · useCountUp()   stat numbers that count to their value
     · useFlash()     short-lived "that worked" state for copy buttons

   Every helper honours prefers-reduced-motion, and nothing here paints: no
   canvas, no gradient, no timer that keeps running when the tab is hidden.

   Safety note on reveals: elements are only hidden *after* JS has taken
   charge of them (the `rv-armed` class is added at observe time). If this
   module never runs, or an element is added after the observer is gone, the
   content simply stays visible instead of disappearing.
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from "react";

export function prefersReducedMotion() {
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

/**
 * Reveals every `[data-rv]` element as it scrolls into view.
 * Returns a cleanup function; safe to call on every route change.
 */
export function initReveals(root) {
	const scope = root && root.querySelectorAll ? root : document;
	const reduced = prefersReducedMotion();
	const supported = typeof IntersectionObserver !== "undefined";

	const showNow = (el) => {
		el.classList.add("rv-armed", "is-in");
	};

	if (reduced || !supported) {
		scope.querySelectorAll("[data-rv]").forEach(showNow);
		return () => {};
	}

	const io = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) return;
				entry.target.classList.add("is-in");
				io.unobserve(entry.target);
			});
		},
		{ rootMargin: "0px 0px -6% 0px", threshold: 0.06 }
	);

	const arm = (el) => {
		if (el.dataset.rvArmed === "1") return;
		el.dataset.rvArmed = "1";
		el.classList.add("rv-armed");
		io.observe(el);
	};

	const armAll = (node) => {
		if (!node || node.nodeType !== 1) return;
		if (node.hasAttribute && node.hasAttribute("data-rv")) arm(node);
		if (node.querySelectorAll) node.querySelectorAll("[data-rv]").forEach(arm);
	};

	armAll(scope === document ? document.body : scope);

	/* Pages fetch their data after mount, so blocks keep arriving. */
	let mo = null;
	if (typeof MutationObserver !== "undefined") {
		mo = new MutationObserver((records) => {
			records.forEach((r) => r.addedNodes.forEach(armAll));
		});
		mo.observe(scope === document ? document.body : scope, {
			childList: true,
			subtree: true,
		});
	}

	/* Belt and braces: anything armed but still on screen after a beat is
	   shown regardless, so a missed callback can never hide real content. */
	const sweep = window.setTimeout(() => {
		document.querySelectorAll("[data-rv].rv-armed:not(.is-in)").forEach((el) => {
			const box = el.getBoundingClientRect();
			if (box.top < window.innerHeight && box.bottom > 0) el.classList.add("is-in");
		});
	}, 2500);

	return () => {
		window.clearTimeout(sweep);
		if (mo) mo.disconnect();
		io.disconnect();
	};
}

/**
 * Counts from the previous value to `value` whenever it changes.
 * Pass `enabled: false` while the real number is still loading.
 */
export function useCountUp(value, { duration = 700, enabled = true } = {}) {
	const raw = Number(value);
	const target = Number.isFinite(raw) ? raw : 0;
	const [shown, setShown] = useState(enabled ? 0 : target);
	const shownRef = useRef(shown);

	useEffect(() => {
		const jump = () => {
			shownRef.current = target;
			setShown(target);
		};
		if (!enabled || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
			jump();
			return undefined;
		}
		const from = shownRef.current;
		if (from === target) return undefined;

		let raf = 0;
		const start = performance.now();
		const tick = (now) => {
			const t = Math.min(1, (now - start) / Math.max(1, duration));
			const eased = 1 - (1 - t) ** 3;
			const next = t >= 1 ? target : from + (target - from) * eased;
			shownRef.current = next;
			setShown(next);
			if (t < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [target, duration, enabled]);

	return shown;
}

/** `[flashing, trigger]` — flips true for `ms`, used for copy confirmations. */
export function useFlash(ms = 1600) {
	const [on, setOn] = useState(false);
	const timer = useRef(0);

	const trigger = useCallback(() => {
		setOn(true);
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setOn(false), ms);
	}, [ms]);

	useEffect(() => () => window.clearTimeout(timer.current), []);

	return [on, trigger];
}
