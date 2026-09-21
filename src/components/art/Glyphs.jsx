import React from "react";

/* ---------------------------------------------------------------------------
   Step glyphs — one 48x48 grid, one stroke weight, one joint style.

   Each shape carries `pathLength="1"`, so a single CSS rule can draw any of
   them on with `stroke-dashoffset` without measuring path lengths in JS. The
   draw-on runs once when the parent reveal element gains `.rv-in`.
--------------------------------------------------------------------------- */

const FRAME = {
  viewBox: "0 0 48 48",
  fill: "none",
  "aria-hidden": "true",
  focusable: "false",
};

/* 1 — the origin API and its keys, stored once */
export function OriginGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <rect x="7" y="11" width="34" height="26" rx="5" pathLength="1" className="gl-draw" />
      <path d="M7 18.5h34" pathLength="1" className="gl-draw gl-d2" />
      <path d="M11.5 14.8h2.6M17 14.8h2.6" pathLength="1" className="gl-draw gl-d2" />
      <circle cx="24" cy="26.5" r="4.2" pathLength="1" className="gl-draw gl-d3" />
      <path d="M24 30.7v3.1" pathLength="1" className="gl-draw gl-d4" />
    </svg>
  );
}

/* 2 — your public model id mapped onto a hidden upstream name */
export function AliasGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <rect x="5" y="9" width="20" height="12" rx="3.4" pathLength="1" className="gl-draw" />
      <path d="M9 15h12" pathLength="1" className="gl-draw gl-d2" />
      <path d="M15 21v9.5a3 3 0 0 0 3 3h6.5" pathLength="1" className="gl-draw gl-d3" />
      <path d="M21.5 30.4 25 33.5l-3.5 3.1" pathLength="1" className="gl-draw gl-d4" />
      <rect x="27" y="27.5" width="16" height="12" rx="3.4" pathLength="1" className="gl-draw gl-d3" />
      <circle cx="31.5" cy="33.5" r="1.25" className="gl-fill gl-d5" />
      <circle cx="35" cy="33.5" r="1.25" className="gl-fill gl-d5" />
      <circle cx="38.5" cy="33.5" r="1.25" className="gl-fill gl-d5" />
    </svg>
  );
}

/* 3 — gateway keys you mint for callers */
export function IssueGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <circle cx="15" cy="24" r="7.5" pathLength="1" className="gl-draw" />
      <circle cx="15" cy="24" r="2.4" pathLength="1" className="gl-draw gl-d3" />
      <path d="M22.5 24h18" pathLength="1" className="gl-draw gl-d2" />
      <path d="M31 24v5.5M36.5 24v4" pathLength="1" className="gl-draw gl-d4" />
      <path d="M26 14.5h14" pathLength="1" className="gl-draw gl-d3" />
      <path d="M26 33.5h8" pathLength="1" className="gl-draw gl-d5" />
    </svg>
  );
}

/* 4 — key health, read from live traffic */
export function PulseGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <circle cx="24" cy="24" r="16.5" pathLength="1" className="gl-draw" />
      <path d="M11.5 24.5h5.5l3-6 4.5 12 3.5-7h8" pathLength="1" className="gl-draw gl-d3" />
      <circle cx="36" cy="12" r="3.4" className="gl-fill gl-live" />
    </svg>
  );
}

/* used by the visibility comparison */
export function OpenGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <circle cx="24" cy="24" r="15.5" pathLength="1" className="gl-draw" />
      <path d="M8.5 24h31" pathLength="1" className="gl-draw gl-d2" />
      <path d="M24 8.5c4.4 5 6.6 10.2 6.6 15.5S28.4 34.5 24 39.5c-4.4-5-6.6-10.2-6.6-15.5S19.6 13.5 24 8.5Z" pathLength="1" className="gl-draw gl-d3" />
    </svg>
  );
}

export function SealedGlyph(props) {
  return (
    <svg {...FRAME} className="glyph" {...props}>
      <rect x="10" y="21" width="28" height="18" rx="5" pathLength="1" className="gl-draw" />
      <path d="M16.5 21v-5a7.5 7.5 0 0 1 15 0v5" pathLength="1" className="gl-draw gl-d3" />
      <path d="M24 27.5v5.5" pathLength="1" className="gl-draw gl-d4" />
    </svg>
  );
}

/* wide, quiet arc bundle behind the closing call to action */
export function CtaArcs({ className = "" }) {
  return (
    <svg
      className={`cta-arcs ${className}`}
      viewBox="0 0 1200 420"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="cta-g" x1="0" y1="0" x2="1200" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="cta-stop-a" />
          <stop offset="0.55" className="cta-stop-b" />
          <stop offset="1" className="cta-stop-c" />
        </linearGradient>
      </defs>
      <path className="cta-arc" pathLength="1" d="M-40 372C220 372 300 76 620 76s420 236 660 236" />
      <path className="cta-arc is-2" pathLength="1" d="M-40 410C240 410 320 150 620 150s400 200 660 200" />
      <path className="cta-arc is-3" pathLength="1" d="M-40 330C200 330 280 18 620 18s440 268 660 268" />
      <circle className="cta-spark" r="4" style={{ "--cta-path": 'path("M-40 372C220 372 300 76 620 76s420 236 660 236")' }} />
      <circle className="cta-spark is-late" r="3" style={{ "--cta-path": 'path("M-40 410C240 410 320 150 620 150s400 200 660 200")' }} />
    </svg>
  );
}
