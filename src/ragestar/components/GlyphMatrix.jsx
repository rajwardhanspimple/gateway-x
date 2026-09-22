/* ==========================================================================
   GlyphMatrix — an animated grid of shifting glyphs on a canvas
   --------------------------------------------------------------------------
   Ported from Magic UI (magicui.design/r/glyph-matrix.json) and adapted for
   this project. Four changes from the registry source, all forced:

     1. TypeScript -> JavaScript. This project has no TS build step.
     2. The "use client" directive is dropped. That is a Next.js App Router
        marker; this is a Vite SPA where every component is already a client
        component.
     3. `next-themes` is not a dependency and never will be here — the gateway
        owns its appearance through the data-theme attribute on <html> (see
        App.jsx). The demo passed `color` down from useTheme(); this version
        reads the attribute and subscribes to `ragestar-theme-change`, the same
        contract AppearanceToggle uses, so the matrix recolours the moment the
        appearance changes.
     4. prefers-reduced-motion is honoured: the grid draws once and holds. The
        registry version animates unconditionally.

   Everything else — the resize handling, the devicePixelRatio scaling, the
   colour probe that resolves any CSS colour to RGBA through a 1x1 canvas, the
   per-cell alpha and the bottom fade — is the registry logic, kept because it
   is careful work: the probe in particular seeds a known fallback first, since
   a 2d context silently keeps its previous fillStyle when handed an invalid
   colour rather than turning black.
   ========================================================================== */

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";

/** Read the live appearance from the document. Anything but "dark" is light. */
function isDarkNow() {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/**
 * GlyphMatrix
 *
 * @param {object}  props
 * @param {string}  props.glyphs        characters to pick from
 * @param {number}  props.cellSize      cell size in px, also the font size
 * @param {number}  props.mutationRate  probability (0-1) a cell mutates per tick
 * @param {number}  props.interval       tick interval in ms
 * @param {number}  props.fadeBottom     fade toward the bottom (0 = none)
 * @param {string}  props.color          explicit glyph colour; omit to follow
 *                                       the appearance automatically
 */
export default function GlyphMatrix({
  glyphs = "01·\u2022+*/\\<>=",
  cellSize = 14,
  mutationRate = 0.04,
  interval = 90,
  className,
  fadeBottom = 0.6,
  color,
  style,
  ...props
}) {
  const canvasRef = useRef(null);
  /* Current glyph colour as RGBA (a in 0-1), in a ref so an appearance change
     recolours the next frame without restarting the animation. */
  const rgbaRef = useRef({ r: 107, g: 114, b: 128, a: 1 });
  const [dark, setDark] = useState(isDarkNow);

  /* Follow the gateway's appearance. Subscribes to the same event
     AppearanceToggle dispatches rather than reading the attribute once, so an
     appearance change from the palette or the keyboard shortcut recolours this
     too. */
  useEffect(() => {
    const onChange = (e) => {
      const d = e?.detail;
      setDark(d === "dark" ? true : d ? false : isDarkNow());
    };
    window.addEventListener("ragestar-theme-change", onChange);
    setDark(isDarkNow());
    return () => window.removeEventListener("ragestar-theme-change", onChange);
  }, []);

  /* An explicit colour prop wins; otherwise pick ink or paper for the
     appearance. These are the kit's own two ink values. */
  const resolved = color ?? (dark ? "#e9ece4" : "#101814");

  /* Resolve the CSS colour string to RGBA. Handles hex, rgb, hsl, oklch and
     anything else the 2d context understands. */
  useEffect(() => {
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext("2d");
    if (!probeCtx) return;
    /* Seed with the default so an invalid colour falls back to it: the context
       keeps its previous fillStyle when assigned an invalid value instead of
       silently turning black. */
    probeCtx.fillStyle = "#6B7280";
    probeCtx.fillStyle = resolved;
    probeCtx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probeCtx.getImageData(0, 0, 1, 1).data;
    rgbaRef.current = { r, g, b, a: a / 255 };
  }, [resolved]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let cols = 0;
    let rows = 0;
    let cells = [];
    let alphas = [];
    let raf = 0;
    let last = 0;
    let stopped = false;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = canvas;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(w / cellSize);
      rows = Math.ceil(h / cellSize);

      cells = new Array(cols * rows)
        .fill(0)
        .map(() => glyphs[Math.floor(Math.random() * glyphs.length)]);
      alphas = new Array(cols * rows).fill(0).map(() => 0.05 + Math.random() * 0.35);
    };

    const draw = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      ctx.clearRect(0, 0, w, h);

      ctx.font = `${cellSize - 2}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = "top";

      const { r, g, b, a: colorAlpha } = rgbaRef.current;
      for (let y = 0; y < rows; y++) {
        const fade = fadeBottom > 0 ? 1 - (y / rows) * fadeBottom : 1;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const a = alphas[i] * fade * colorAlpha;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          ctx.fillText(cells[i], x * cellSize, y * cellSize);
        }
      }
    };

    const tick = (t) => {
      if (stopped) return;

      if (t - last >= interval) {
        last = t;

        const total = cols * rows;
        const mutations = Math.max(1, Math.floor(total * mutationRate));

        for (let n = 0; n < mutations; n++) {
          const i = Math.floor(Math.random() * total);
          cells[i] = glyphs[Math.floor(Math.random() * glyphs.length)];
          alphas[i] = 0.05 + Math.random() * 0.45;
        }

        draw();
      }

      raf = requestAnimationFrame(tick);
    };

    resize();
    draw();
    /* Reduced motion: the grid is drawn and holds. A static field of glyphs is
       still the intended texture, so there is nothing to replace it with. */
    if (!reduced) raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [glyphs, cellSize, mutationRate, interval, fadeBottom]);

  /* Redraw on an appearance change even while reduced motion holds the loop:
     the colour ref has moved but no tick will come to repaint it. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }, [resolved]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("pointer-events-none", className)}
      style={{ width: "100%", height: "100%", display: "block", ...style }}
      aria-hidden="true"
      {...props}
    />
  );
}
