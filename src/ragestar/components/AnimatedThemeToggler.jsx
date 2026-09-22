/* ==========================================================================
   AnimatedThemeToggler — the appearance switch, with a View Transition wipe
   --------------------------------------------------------------------------
   Ported from Magic UI (magicui.design/r/animated-theme-toggler.json) and
   rewired to this project's appearance contract.

   WHAT THE REGISTRY VERSION DID THAT WOULD HAVE BROKEN THINGS

   It toggles a `.dark` CLASS on <html> and persists to localStorage["theme"].
   This app keys everything off the `data-theme` ATTRIBUTE and persists to
   localStorage["ragestar-theme"] — see the bootstrap in main.jsx, the state in
   App.jsx and every [data-theme="dark"] rule in the appearance sheets. Left as
   shipped it would have written a class nothing reads, saved a key nothing
   loads, and desynced from the keyboard shortcut and the command palette.

   So `applyTheme` here calls setAppearance() from AppearanceToggle.jsx, which
   is the single writer: it sets the attribute, persists under the right key,
   and dispatches ragestar-theme-change so every other switch agrees.

   Other adaptations:
     · TypeScript -> JavaScript, and the "use client" directive dropped (Vite).
     · lucide-react is not a dependency, so the sun and moon are inlined as
       SVG rather than adding a package for two icons.
     · The MutationObserver watches the data-theme attribute instead of class,
       and the component also subscribes to ragestar-theme-change so a switch
       from elsewhere updates the icon.

   Kept from the registry, because it is careful work worth keeping: the clip
   paths are expressed in PERCENTAGES of the snapshot reference box, because
   Chrome 150 renders absolute px clip-path coordinates on
   ::view-transition-new(root) unscaled at fractional display scales for the
   first transition after load; the collapsed clip-path is also pinned through
   a CSS custom property so Firefox cannot paint the new appearance unclipped
   between the snapshot and the JS animation.
   ========================================================================== */

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "../lib/cn.js";
import { setAppearance } from "./AppearanceToggle.jsx";

function polygonCollapsed(point, vertexCount) {
  const pairs = Array.from({ length: vertexCount }, () => point).join(", ");
  return `polygon(${pairs})`;
}

/* All coordinates are percentages of the snapshot reference box — see the
   header for why px would be wrong. */
function getThemeTransitionClipPaths(variant, cx, cy, maxRadius, viewportWidth, viewportHeight) {
  const toX = (x) => `${(x / viewportWidth) * 100}%`;
  const toY = (y) => `${(y / viewportHeight) * 100}%`;
  const point = (x, y) => `${toX(x)} ${toY(y)}`;
  /* circle() percentage radii resolve against hypot(w, h) / sqrt(2). */
  const toRadius = (r) =>
    `${(r / (Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2)) * 100}%`;

  switch (variant) {
    case "square": {
      const halfW = Math.max(cx, viewportWidth - cx);
      const halfH = Math.max(cy, viewportHeight - cy);
      const halfSide = Math.max(halfW, halfH) * 1.05;
      const end = [
        point(cx - halfSide, cy - halfSide),
        point(cx + halfSide, cy - halfSide),
        point(cx + halfSide, cy + halfSide),
        point(cx - halfSide, cy + halfSide),
      ].join(", ");
      return [polygonCollapsed(point(cx, cy), 4), `polygon(${end})`];
    }
    case "diamond": {
      const R = maxRadius * Math.SQRT2;
      const end = [
        point(cx, cy - R),
        point(cx + R, cy),
        point(cx, cy + R),
        point(cx - R, cy),
      ].join(", ");
      return [polygonCollapsed(point(cx, cy), 4), `polygon(${end})`];
    }
    case "hexagon": {
      const R = maxRadius * Math.SQRT2;
      const verts = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        verts.push(point(cx + R * Math.cos(a), cy + R * Math.sin(a)));
      }
      return [polygonCollapsed(point(cx, cy), 6), `polygon(${verts.join(", ")})`];
    }
    case "circle":
    default:
      return [
        `circle(0% at ${point(cx, cy)})`,
        `circle(${toRadius(maxRadius)} at ${point(cx, cy)})`,
      ];
  }
}

function isDarkNow() {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.2" />
      <path
        d="M12 2.6v2.4M12 19v2.4M4.4 12H2M22 12h-2.4M6.1 6.1 4.4 4.4M19.6 19.6l-1.7-1.7M17.9 6.1l1.7-1.7M4.4 19.6l1.7-1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <path d="M20.5 14.3A8.6 8.6 0 1 1 9.7 3.5a6.9 6.9 0 0 0 10.8 10.8Z" strokeLinejoin="round" />
    </svg>
  );
}

export function AnimatedThemeToggler({
  className,
  duration = 400,
  variant,
  fromCenter = false,
  ...props
}) {
  const shape = variant ?? "circle";
  const [isDark, setIsDark] = useState(isDarkNow);
  const buttonRef = useRef(null);
  const isTransitioningRef = useRef(false);
  const activeAnimRef = useRef(null);

  const cancelAnim = useCallback(() => {
    activeAnimRef.current?.cancel();
    activeAnimRef.current = null;
  }, []);

  /* Leave the document clean if this unmounts mid-transition. */
  useEffect(() => {
    return () => {
      cancelAnim();
      const root = document.documentElement;
      if (root.dataset.magicuiThemeVt !== "active") return;
      delete root.dataset.magicuiThemeVt;
      root.style.removeProperty("--magicui-theme-toggle-vt-duration");
      root.style.removeProperty("--magicui-theme-vt-clip-from");
    };
  }, [cancelAnim]);

  /* Stay in step with every other switch. The event is the primary signal; the
     observer catches a direct attribute write (the first-paint bootstrap). */
  useEffect(() => {
    const sync = () => setIsDark(isDarkNow());
    const onEvent = (e) => {
      const d = e?.detail;
      setIsDark(d === "dark" ? true : d ? false : isDarkNow());
    };
    window.addEventListener("ragestar-theme-change", onEvent);
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    sync();
    return () => {
      window.removeEventListener("ragestar-theme-change", onEvent);
      observer.disconnect();
    };
  }, []);

  const toggleTheme = useCallback(() => {
    const button = buttonRef.current;
    if (
      !button ||
      isTransitioningRef.current ||
      document.documentElement.dataset.magicuiThemeVt === "active"
    ) {
      return;
    }

    /* innerWidth/innerHeight, not visualViewport: percentages resolve against
       the snapshot reference box, which includes classic scrollbars. */
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x;
    let y;
    if (fromCenter) {
      x = viewportWidth / 2;
      y = viewportHeight / 2;
    } else {
      const { top, left, width, height } = button.getBoundingClientRect();
      x = left + width / 2;
      y = top + height / 2;
    }

    const maxRadius = Math.hypot(
      Math.max(x, viewportWidth - x),
      Math.max(y, viewportHeight - y),
    );

    /* The one real rewire: go through the project's single appearance writer
       rather than toggling a class and writing localStorage["theme"]. */
    const applyTheme = () => {
      const next = isDark ? "light" : "dark";
      setAppearance(next);
      setIsDark(next === "dark");
    };

    if (typeof document.startViewTransition !== "function") {
      applyTheme();
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyTheme();
      return;
    }

    const clipPath = getThemeTransitionClipPaths(
      shape,
      x,
      y,
      maxRadius,
      viewportWidth,
      viewportHeight,
    );

    const root = document.documentElement;
    root.dataset.magicuiThemeVt = "active";
    root.style.setProperty("--magicui-theme-toggle-vt-duration", `${duration}ms`);
    /* Pin the collapsed clip-path via CSS so Firefox does not paint the new
       appearance unclipped between the snapshot and the ready.then() animation. */
    root.style.setProperty("--magicui-theme-vt-clip-from", clipPath[0]);

    const cleanup = () => {
      isTransitioningRef.current = false;
      delete root.dataset.magicuiThemeVt;
      root.style.removeProperty("--magicui-theme-toggle-vt-duration");
      root.style.removeProperty("--magicui-theme-vt-clip-from");
      cancelAnim();
    };

    isTransitioningRef.current = true;
    const transition = document.startViewTransition(() => {
      flushSync(applyTheme);
    });
    if (typeof transition?.finished?.finally === "function") {
      transition.finished.finally(cleanup).catch(() => {});
    } else {
      cleanup();
    }

    const ready = transition?.ready;
    if (ready && typeof ready.then === "function") {
      ready
        .then(() => {
          activeAnimRef.current = document.documentElement.animate(
            { clipPath },
            {
              duration,
              easing: "ease-in-out",
              fill: "forwards",
              pseudoElement: "::view-transition-new(root)",
            },
          );
        })
        .catch(() => {});
    }
  }, [shape, fromCenter, duration, isDark, cancelAnim]);

  const label = isDark ? "Switch to light appearance" : "Switch to dark appearance";

  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={toggleTheme}
      className={cn(className)}
      title={label}
      aria-label={label}
      aria-pressed={isDark}
      {...props}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

export default AnimatedThemeToggler;
