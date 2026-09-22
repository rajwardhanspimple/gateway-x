/* ==========================================================================
   Ambient — the backdrop behind every RageStar screen
   --------------------------------------------------------------------------
   Four layers, on one rule: motion either answers the reader or represents the
   product. See ambient.css for what this replaced and why.

     grid       static ruled paper
     routes     five wires converging on one hub, packets running inward —
                the shape of a gateway: many callers, one endpoint
     spotlight  follows the pointer
     texture    static depth wash, grain, vignette

   Same export, same `intensity` prop and same call sites as the version it
   replaces, so site.jsx and RageStarApp.jsx need no edit. `intensity` now
   scales the number of packets in flight (capped at 6) rather than spawning up
   to 26 drifting motes.

   Performance. The pointer handler writes two CSS custom properties inside a
   single rAF and never touches React state, so moving the mouse does not
   re-render the tree. The packets are pure CSS animation on `transform` and
   `opacity`, both compositor properties, so they never trigger layout.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import "./ambient.css";

/* The viewBox the wires are drawn in. Fixed and unitless: the SVG scales with
   preserveAspectRatio="none", so these are proportions, not pixels. */
const VB = 1000;
const HUB = VB / 2;

/* Five callers on the edges, each with its own wire into the hub. Positions
   are deliberately uneven — a symmetrical fan reads as a decoration, an
   uneven one reads as a diagram. */
const ROUTES = [
  { x: 60, y: 180, bend: -70 },
  { x: 930, y: 120, bend: 60 },
  { x: 120, y: 820, bend: 80 },
  { x: 880, y: 760, bend: -60 },
  { x: 500, y: 40, bend: 0 },
];

/** A quadratic from a caller to the hub, bent so the wires do not all read as spokes. */
function wirePath({ x, y, bend }) {
  const mx = (x + HUB) / 2 + bend;
  const my = (y + HUB) / 2 - bend * 0.4;
  return `M ${x} ${y} Q ${mx} ${my} ${HUB} ${HUB}`;
}

export default function Ambient({ intensity = 26 }) {
  const root = useRef(null);
  const [hasPointer, setHasPointer] = useState(false);

  /* intensity is the old prop and the old call sites still pass 12 or 26.
     Map it onto a packet count instead of a mote count: 12 -> 3, 26 -> 6. */
  const packetCount = Math.max(2, Math.min(6, Math.round(intensity / 4.5)));

  /* One packet per wire, cycling if there are more packets than wires. Timings
     are staggered and irregular so the five do not pulse in unison. */
  const packets = useMemo(
    () =>
      Array.from({ length: packetCount }, (_, i) => {
        const route = ROUTES[i % ROUTES.length];
        return {
          key: i,
          x: route.x,
          y: route.y,
          dx: HUB - route.x,
          dy: HUB - route.y,
          /* 7-11s: slow enough to read as traffic, not as a screensaver */
          dur: 7 + ((i * 1.7) % 4),
          delay: -(i * 2.3) % 9,
          r: 2.5,
        };
      }),
    [packetCount],
  );

  /* The spotlight. Writes custom properties in a rAF; no React state, so
     pointer movement never re-renders. */
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;

    let frame = 0;
    let pending = null;

    const write = () => {
      frame = 0;
      if (!pending || !root.current) return;
      root.current.style.setProperty("--amb-x", `${pending.x}%`);
      root.current.style.setProperty("--amb-y", `${pending.y}%`);
    };

    const onMove = (e) => {
      pending = {
        x: ((e.clientX / window.innerWidth) * 100).toFixed(2),
        y: ((e.clientY / window.innerHeight) * 100).toFixed(2),
      };
      if (!hasPointer) setHasPointer(true);
      if (!frame) frame = window.requestAnimationFrame(write);
    };

    const onLeave = () => setHasPointer(false);

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hasPointer]);

  return (
    <div className="amb" ref={root} data-pointer={hasPointer} aria-hidden="true">
      <div className="amb-grid" />

      <svg className="amb-routes" viewBox={`0 0 ${VB} ${VB}`} preserveAspectRatio="none" focusable="false">
        {ROUTES.map((r) => (
          <path key={`${r.x}-${r.y}`} className="amb-wire" d={wirePath(r)} />
        ))}
        <circle className="amb-hub" cx={HUB} cy={HUB} r={30} />
        <circle className="amb-hub" cx={HUB} cy={HUB} r={54} />
        {packets.map((p) => (
          <circle
            key={p.key}
            className="amb-packet"
            cx={p.x}
            cy={p.y}
            r={p.r}
            style={{
              "--dx": p.dx,
              "--dy": p.dy,
              animationDuration: `${p.dur}s`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </svg>

      <div className="amb-depth" />
      <div className="amb-spot" />
      <div className="amb-grain" />
      <div className="amb-vignette" />
    </div>
  );
}
