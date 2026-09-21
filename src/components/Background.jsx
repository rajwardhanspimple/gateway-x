import React from "react";

/* ---------------------------------------------------------------------------
   Page backdrop.

   Three layers, drawn once, no canvas and no randomness:
     1. a soft static wash for depth
     2. one SVG "weave" — an engineered 60px grid faded by a radial mask, plus
        three long route traces that echo the hero diagram
     3. a vignette so the edges never fight the content

   The traces are the only motion: a single dash segment travelling a very long
   path over 26-42s. It reads as traffic, not as a screensaver, and it stops
   under prefers-reduced-motion (see styles/background.css).
--------------------------------------------------------------------------- */

const NODES = [
  [240, 180],
  [480, 360],
  [720, 120],
  [960, 420],
  [1200, 240],
];

const TRACES = [
  "M-80 250C220 250 300 420 620 420S1000 250 1520 250",
  "M-80 620C260 620 360 470 700 470S1080 640 1520 640",
  "M-80 120C300 120 420 300 760 300S1180 120 1520 120",
];

export default function Background() {
  return (
    <div className="bg-stage" aria-hidden="true">
      <div className="bg-wash" />

      <svg
        className="bg-weave"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMin slice"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <pattern id="bgw-grid" width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M60 0H0v60" fill="none" className="bgw-line" />
          </pattern>
          <radialGradient id="bgw-fade" cx="0.5" cy="0.04" r="0.82">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.24" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <mask id="bgw-mask">
            <rect x="0" y="0" width="1440" height="900" fill="url(#bgw-fade)" />
          </mask>
        </defs>

        <g mask="url(#bgw-mask)">
          <rect x="0" y="0" width="1440" height="900" fill="url(#bgw-grid)" opacity="0.55" />
          {NODES.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" className="bgw-dot" />
          ))}
          {TRACES.map((d, i) => (
            <path key={i} d={d} className={`bgw-trace${i ? ` is-${i + 1}` : ""}`} />
          ))}
        </g>
      </svg>

      <div className="bg-vignette" />
    </div>
  );
}
