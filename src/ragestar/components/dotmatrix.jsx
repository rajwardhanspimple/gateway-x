/**
 * DotmSquare1 — "Neon Drift" from the @dotmatrix registry.
 * A 5×5 dot matrix whose wave sweeps from the top-right toward the
 * bottom-left, with alternating diagonals offset by half a cycle.
 */

import { useState } from "react";
import "./dotmatrix.css";
import { cn } from "../lib/cn.js";

const COLOR_PRESETS = {
  "solid-theme": { fill: "var(--color-dot-on, currentColor)", glow: "var(--color-dot-on, currentColor)" },
  "solid-mint": { fill: "#34d399", glow: "#34d399" },
  "grad-sunset": { fill: "linear-gradient(135deg, #ff5f6d 0%, #ffc371 52%, #ffe29a 100%)", glow: "#ff8b73" },
  "grad-ocean": { fill: "linear-gradient(140deg, #00c6ff 0%, #0072ff 48%, #4facfe 100%)", glow: "#2f8fff" },
  "grad-neon": { fill: "linear-gradient(145deg, #b4ff39 0%, #39ffb6 46%, #00d4ff 100%)", glow: "#59ffc8" },
  "grad-aurora": { fill: "linear-gradient(145deg, #ff3cac 0%, #784ba0 45%, #2b86c5 100%)", glow: "#9c64bf" },
  "grad-fire": { fill: "linear-gradient(145deg, #ff512f 0%, #dd2476 45%, #ffb347 100%)", glow: "#f96a5f" },
  "grad-ragestar": { fill: "linear-gradient(145deg, #12c2e9 0%, #c471ed 45%, #f64f59 100%)", glow: "#9e7de8" },
};

const N = 5;
const CENTER = Math.floor(N / 2);

function inPattern(pattern, row, col) {
  switch (pattern) {
    case "full":
      return true;
    case "diamond":
      return Math.abs(row - CENTER) + Math.abs(col - CENTER) <= CENTER;
    case "outline":
      return row === 0 || row === N - 1 || col === 0 || col === N - 1;
    case "cross":
      return row === CENTER || col === CENTER;
    case "rings": {
      const r = Math.round(Math.hypot(row - CENTER, col - CENTER));
      return r === 1 || r === 2;
    }
    case "rose": {
      const dx = col - CENTER;
      const dy = row - CENTER;
      const angle = Math.atan2(dy, dx);
      const radius = Math.hypot(dx, dy);
      return Math.abs(Math.sin(3 * angle)) > 0.6 && radius >= 1;
    }
    default:
      return true;
  }
}

function usePrefersReducedMotion() {
  const [reduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  return reduced;
}

/** Normalized position along the top-right → bottom-left diagonal path. */
function trBlPathNorm(row, col) {
  const slice = row + (N - 1 - col);
  return slice / (2 * (N - 1));
}

export function DotmSquare1({
  size = 24,
  dotSize = 3,
  color = "currentColor",
  colorPreset,
  speed = 1,
  ariaLabel = "Loading",
  className,
  pattern = "full",
  muted = false,
  bloom = false,
  halo = 0,
  animated = true,
  hoverAnimated = false,
  dotClassName,
  dotShape = "circle",
  opacityBase,
  opacityMid,
  opacityPeak,
  cellPadding,
  onMouseEnter,
  onMouseLeave,
  ...rest
}) {
  const reduced = usePrefersReducedMotion();
  const [hovering, setHovering] = useState(false);

  const gap = cellPadding ?? Math.max(1, Math.floor((size - dotSize * N) / (N - 1)));
  const span = dotSize * N + gap * (N - 1);
  const preset = colorPreset ? COLOR_PRESETS[colorPreset] : undefined;
  const dotFill = preset?.fill ?? color;
  const glowColor = preset?.glow ?? color;
  const glowing = bloom || halo > 0;
  const motionOn = animated && !reduced;
  const animClass = !motionOn ? "" : hovering && hoverAnimated ? "dmx-hover-ripple" : "dmx-diagonal-alt-sweep";

  const rootStyle = {
    width: span,
    height: span,
    gridTemplateColumns: `repeat(${N}, ${dotSize}px)`,
    gap: `${gap}px`,
    color: glowColor,
    opacity: muted ? 0.45 : undefined,
    "--dmx-speed": speed > 0 ? 1 / speed : 1,
    "--dmx-dot-fill": dotFill,
    ...(opacityBase !== undefined && { "--dmx-opacity-base": opacityBase }),
    ...(opacityMid !== undefined && { "--dmx-opacity-mid": opacityMid }),
    ...(opacityPeak !== undefined && { "--dmx-opacity-peak": opacityPeak }),
    ...(glowing && {
      "--dmx-glow": glowColor,
      "--dmx-glow-px": `${(halo * 5 + (bloom ? 1.5 : 0)).toFixed(1)}px`,
    }),
  };

  const shapeStyle =
    dotShape === "circle"
      ? { borderRadius: "50%" }
      : dotShape === "square"
        ? { borderRadius: Math.max(1, Math.round(dotSize * 0.18)) }
        : { borderRadius: 1, transform: "rotate(45deg) scale(0.84)" };

  const dots = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const active = inPattern(pattern, row, col);
      const slice = row + (N - 1 - col);
      const parity = slice % 2;
      const style = {
        width: dotSize,
        height: dotSize,
        ...shapeStyle,
        "--dmx-path": trBlPathNorm(row, col),
        "--dmx-diagonal-parity": parity,
        "--dmx-distance": Math.hypot(row - CENTER, col - CENTER),
        ...(animClass === "" && active ? { opacity: parity === 0 ? 0.88 : 0.14 } : {}),
      };

      dots.push(
        <span
          key={`${row}-${col}`}
          className={cn("dmx-dot", active ? animClass : "dmx-inactive", dotClassName)}
          style={style}
        />,
      );
    }
  }

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      {...rest}
      className={cn("dmx-root", glowing && "dmx-glow", className)}
      style={rootStyle}
      onMouseEnter={(e) => {
        setHovering(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovering(false);
        onMouseLeave?.(e);
      }}
    >
      {dots}
    </span>
  );
}

export default DotmSquare1;
