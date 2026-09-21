/* ==========================================================================
   RouteLoader — the screen-to-screen hand-off
   --------------------------------------------------------------------------
   App.jsx computes a route transition; this is what it renders.

     phase "cover"  a plate covers the viewport, the mark sits in the middle
     phase "dock"   the next screen has painted — the plate dissolves and the
                    mark travels into the logo slot of the new screen

   The travel is a FLIP move. We measure the mark where it is, measure the
   real logo on the screen underneath (`.pr-brand-mark` on every RageStar
   screen — landing nav, page nav, auth wordmark, dashboard rail) and hand
   the delta to CSS as
   --rl-x / --rl-y / --rl-s. No hard-coded coordinates, so it lands correctly
   on every chrome at any viewport size.

   v12: the mark now sits in a stage — a progress ring that fills while the
   route loads, three dots in orbit, a breathing glow, a beam sweeping the
   plate, and a readable percentage. The ring is driven by real state, so it
   only reaches 100% when the next screen actually paints.

   RULES OF HOOKS: every hook sits in one block at the top, before any return.
   ========================================================================== */

import React, { useEffect, useRef, useState } from "react";
/* RageStarMark, not Logo: the plate hands its mark to a RageStar logo tile now. */
import { RageStarMark } from "./brand.jsx";

/* first match wins: the RageStar kit's logo tile (.pr-brand-mark — landing nav,
   page nav, auth wordmark, dashboard rail) comes first because every routed
   screen is a RageStar screen now; the retired gateway chrome follows, then the
   wordmarks, in case a screen renders no mark at all */
const TARGETS = [
  ".ragestar-scope .pr-brand-mark",
  ".pr-brand-mark",
  ".con-topbar .brand-mark",
  ".wk-rail .brand-mark",
  ".site-header .brand-mark",
  ".adm-topbar .brand-mark",
  ".con-topbar .brand",
  ".wk-brand",
  ".site-header .brand",
];

/* circumference of the r=52 ring in the 120x120 viewBox */
const RING = Math.round(2 * Math.PI * 52 * 10) / 10;

/* the ring creeps towards this while waiting; only a finished route pushes it
   to 100 — a loader that claims 100% and keeps waiting is worse than one that
   admits it is still working */
const CEILING = 92;
const TICK_MS = 70;

function findTarget() {
  for (const selector of TARGETS) {
    const el = document.querySelector(selector);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return r;
    }
  }
  return null;
}

export default function RouteLoader({ phase = "cover", label }) {
  const markRef = useRef(null);
  const [flip, setFlip] = useState(null);
  const [pct, setPct] = useState(8);

  /* measure here, measure there, hand the delta to CSS */
  useEffect(() => {
    if (phase !== "dock") return undefined;
    const mark = markRef.current;
    if (!mark) return undefined;

    const raf = window.requestAnimationFrame(() => {
      const from = mark.getBoundingClientRect();
      if (!from.width) return;
      const to = findTarget();

      /* fallback: straight up and out of frame, for routes with no chrome */
      let x = 0;
      let y = -Math.round(window.innerHeight * 0.42);
      let scale = 0.34;

      if (to) {
        x = Math.round(to.left + to.width / 2 - (from.left + from.width / 2));
        y = Math.round(to.top + to.height / 2 - (from.top + from.height / 2));
        scale = Math.round((to.width / from.width) * 1000) / 1000;
      }

      setFlip({ "--rl-x": `${x}px`, "--rl-y": `${y}px`, "--rl-s": scale });
    });

    return () => window.cancelAnimationFrame(raf);
  }, [phase]);

  /* the ring: ease towards the ceiling while covering, snap full on dock */
  useEffect(() => {
    if (phase === "dock") {
      setPct(100);
      return undefined;
    }
    const id = window.setInterval(() => {
      setPct((p) =>
        p >= CEILING
          ? CEILING
          : Math.min(CEILING, p + Math.max(0.7, (CEILING - p) * 0.09)),
      );
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [phase]);

  /* no hooks past this point */
  const shown = Math.round(pct);
  const offset = Math.round(RING * (1 - pct / 100) * 10) / 10;

  return (
    <div
      className={`rl ${phase === "dock" ? "is-dock" : "is-enter"}`}
      role="status"
      aria-live="polite"
      aria-label={label ? `Loading ${label}` : "Loading"}
    >
      <span className="rl-beam" aria-hidden="true" />

      <div className="rl-inner">
        <div className="rl-stage">
          <span className="rl-glow" aria-hidden="true" />

          <svg className="rl-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle className="rl-ring-bg" cx="60" cy="60" r="52" />
            <circle
              className="rl-ring-arc"
              cx="60"
              cy="60"
              r="52"
              style={{ strokeDasharray: RING, strokeDashoffset: offset }}
            />
          </svg>

          <span className="rl-orbit" aria-hidden="true">
            <i className="rl-orbit-dot" />
            <i className="rl-orbit-dot d2" />
            <i className="rl-orbit-dot d3" />
          </span>

          <span className="rl-mark" ref={markRef} style={flip || undefined}>
            <RageStarMark size="100%" />
          </span>
        </div>

        <span className="rl-label">{label || "loading"}</span>

        <span className="rl-track" aria-hidden="true">
          <i style={{ transform: `translateX(${shown - 100}%)` }} />
        </span>

        <span className="rl-status">
          <em className="rl-pct">{shown}%</em>
          <span className="rl-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
    </div>
  );
}
