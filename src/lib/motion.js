/* ==========================================================================
   Motion runtime
   --------------------------------------------------------------------------
   src/lib/interactive.js reveals blocks that opted in by hand with [data-rv].
   That covered five marketing pages and nothing else, so the console, the
   admin panel and the auth screens arrived as a dead slab.

   initMotion() gives every surface in the app an arrival without touching a
   hundred JSX files: it walks a list of structural selectors, stamps each
   match with `data-m` + a stagger index, and reveals it when it scrolls into
   view. Styling lives in src/styles/motion.css.

   Safety, same contract as interactive.js:
     · an element is only hidden *after* it has been armed by this file, so if
       the module never runs the page stays fully visible
     · a late sweep un-hides anything the observer missed
     · prefers-reduced-motion arms nothing and reveals everything immediately
   ========================================================================== */

import { useEffect, useRef, useState } from "react"

export function prefersReducedMotion() {
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches
	} catch {
		return false
	}
}

/* Structural surfaces worth animating, with the variant each one uses.
   Order matters only for readability — every node is armed once. */
const TARGETS = [
	{ sel: ".adm-stats > .adm-stat", variant: "pop" },
	{ sel: ".adm-card", variant: "rise" },
	{ sel: ".adm-table-wrap", variant: "rise" },
	{ sel: ".adm-empty", variant: "fade" },
	{ sel: ".con-quick button", variant: "rise" },
	{ sel: ".credit-hero", variant: "rise" },
	{ sel: ".key-new", variant: "pop" },
	{ sel: ".con-meta li", variant: "left", row: true },
	{ sel: ".adm-table tbody tr", variant: "fade", row: true },
	{ sel: ".pg-card", variant: "rise" },
	{ sel: ".pg-meta-cell", variant: "pop", row: true },
	{ sel: ".sui-field", variant: "fade", row: true },
]

/* Elements that must never be hidden even for a frame: anything the person is
   typing into, plus live regions. */
const SKIP = "input, textarea, select, [role='alert'], [aria-live]"

function armIndexes(el, row) {
	/* stagger within the immediate parent, capped so a 100-row table does not
	   take four seconds to finish arriving */
	const parent = el.parentElement
	if (!parent) return
	let i = 0
	for (const child of parent.children) {
		if (child === el) break
		if (child.hasAttribute && child.hasAttribute("data-m")) i += 1
	}
	el.style.setProperty("--m-i", String(Math.min(i, row ? 12 : 6)))
}

/**
 * Arms every structural surface under `root` and reveals it on scroll.
 * Returns a cleanup function; safe to call on every route or tab change.
 */
export function initMotion(root) {
	const scope = root && root.querySelectorAll ? root : document
	const host = scope === document ? document.body : scope
	if (!host) return () => {}

	const reduced = prefersReducedMotion()
	const supported = typeof IntersectionObserver !== "undefined"

	const show = (el) => el.classList.add("m-armed", "m-in")

	if (reduced || !supported) {
		/* nothing is ever hidden in this branch — arm and reveal in one go */
		host.querySelectorAll("[data-m]").forEach(show)
		return () => {}
	}

	const io = new IntersectionObserver(
		(entries) => {
			entries.forEach((entry) => {
				if (!entry.isIntersecting) return
				entry.target.classList.add("m-in")
				io.unobserve(entry.target)
			})
		},
		{ rootMargin: "0px 0px -4% 0px", threshold: 0.04 }
	)

	const arm = (el, variant, row) => {
		if (!el || el.dataset.mArmed === "1") return
		if (el.matches && el.matches(SKIP)) return
		/* hand-written [data-rv] blocks already have an arrival — leave them */
		if (el.hasAttribute("data-rv")) return
		el.dataset.mArmed = "1"
		if (!el.getAttribute("data-m")) el.setAttribute("data-m", variant)
		if (row) el.classList.add("m-row")
		armIndexes(el, row)
		el.classList.add("m-armed")
		io.observe(el)
	}

	const armAll = (node) => {
		if (!node || node.nodeType !== 1) return
		for (const { sel, variant, row } of TARGETS) {
			if (node.matches && node.matches(sel)) arm(node, variant, row)
			if (node.querySelectorAll) {
				node.querySelectorAll(sel).forEach((el) => arm(el, variant, row))
			}
		}
	}

	armAll(host)

	/* Console tabs, tables and admin screens all render after their fetch
	   resolves, so keep watching for new blocks. */
	let mo = null
	if (typeof MutationObserver !== "undefined") {
		mo = new MutationObserver((records) => {
			records.forEach((r) => r.addedNodes.forEach(armAll))
		})
		mo.observe(host, { childList: true, subtree: true })
	}

	/* Belt and braces: anything armed but still hidden after a beat is shown
	   regardless, so a missed callback can never eat real content. */
	const sweep = window.setTimeout(() => {
		document.querySelectorAll("[data-m].m-armed:not(.m-in)").forEach((el) => {
			const box = el.getBoundingClientRect()
			if (box.top < window.innerHeight * 1.4 && box.bottom > -200) {
				el.classList.add("m-in")
			}
		})
	}, 1800)

	const rescue = window.setTimeout(() => {
		document.querySelectorAll("[data-m].m-armed:not(.m-in)").forEach((el) => {
			if (!el.isConnected) return
			if (!el.offsetParent && el.offsetHeight === 0) el.classList.add("m-in")
		})
	}, 6000)

	return () => {
		window.clearTimeout(sweep)
		window.clearTimeout(rescue)
		if (mo) mo.disconnect()
		io.disconnect()
	}
}

/**
 * Reveals `text` a few characters per frame, so a gateway answer arrives the
 * way a streamed one would. Returns `[shown, done]`.
 *
 * Long answers are revealed in bigger bites: the point is momentum, not
 * making someone wait for 4 kB of JSON.
 */
export function useTypewriter(text, { cps = 420, enabled = true } = {}) {
	const full = typeof text === "string" ? text : ""
	const [shown, setShown] = useState(full)
	const frame = useRef(0)

	useEffect(() => {
		if (!full) {
			setShown("")
			return undefined
		}
		if (
			!enabled ||
			prefersReducedMotion() ||
			typeof requestAnimationFrame !== "function"
		) {
			setShown(full)
			return undefined
		}

		setShown("")
		const started = performance.now()
		const step = (now) => {
			const elapsed = (now - started) / 1000
			const chars = Math.max(1, Math.round(elapsed * cps))
			if (chars >= full.length) {
				setShown(full)
				return
			}
			setShown(full.slice(0, chars))
			frame.current = requestAnimationFrame(step)
		}
		frame.current = requestAnimationFrame(step)
		return () => cancelAnimationFrame(frame.current)
	}, [full, cps, enabled])

	return [shown, shown.length >= full.length]
}

/** Milliseconds a request has been in flight, for a live timer while busy. */
export function useElapsed(running) {
	const [msElapsed, setMs] = useState(0)

	useEffect(() => {
		if (!running) return undefined
		const started = performance.now()
		setMs(0)
		const id = window.setInterval(() => {
			setMs(Math.round(performance.now() - started))
		}, 100)
		return () => window.clearInterval(id)
	}, [running])

	return msElapsed
}
