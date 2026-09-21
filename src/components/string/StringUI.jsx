/* ==========================================================================
   String UI — React bindings for the StringTune engine
   --------------------------------------------------------------------------
   Every component here is a thin wrapper that emits the StringTune attribute
   contract (`string="progress"`, `string="lazy"`, `string-enter-vp`, ...).
   The engine writes `--progress` (0 → 1) onto the element while it travels
   through the viewport; CSS does the rest, so animation stays off the main
   React render path.
   ========================================================================== */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bootStringTune,
  getStringMode,
  rescanStringTune,
} from "../../lib/stringTune.js";

const StringCtx = createContext({ mode: "pending" });
export const useStringEngine = () => useContext(StringCtx);

/* ------------------------------------------------------------- provider */
export function StringProvider({ children, route }) {
  const [mode, setMode] = useState(getStringMode);

  useEffect(() => {
    let alive = true;
    bootStringTune().then((m) => alive && setMode(m));
    return () => {
      alive = false;
    };
  }, []);

  // Routes swap the whole tree — tell the engine to pick up the new nodes.
  useEffect(() => {
    const id = requestAnimationFrame(() => rescanStringTune());
    return () => cancelAnimationFrame(id);
  }, [route]);

  const value = useMemo(() => ({ mode }), [mode]);
  return <StringCtx.Provider value={value}>{children}</StringCtx.Provider>;
}

/* ------------------------------------------------------- string=progress */
export function StringProgress({
  as: Tag = "div",
  enter = "top",
  exit = "bottom",
  className = "",
  children,
  ...rest
}) {
  return (
    <Tag
      string="progress"
      string-enter-vp={enter}
      string-exit-vp={exit}
      className={`str-progress ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* Scroll-linked rail: a hairline that fills with --progress. */
export function StringRail({ label, className = "" }) {
  return (
    <StringProgress enter="bottom" exit="top" className={`str-rail ${className}`}>
      <span className="str-rail-track" aria-hidden="true">
        <i />
      </span>
      {label ? <span className="str-rail-label mono xs">{label}</span> : null}
    </StringProgress>
  );
}

/* ----------------------------------------------------------- string=lazy */
export function StringLazyImage({ src, alt = "", className = "", ...rest }) {
  return (
    <img
      string="lazy"
      string-lazy={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={`str-lazy ${className}`}
      {...rest}
    />
  );
}

/* ---------------------------------------------------------- split text fx
   Mirrors StringTune's split DOM (`-splitted` / `-s-word` / `-s-char`) so the
   same CSS drives it whether the engine or React performs the split.        */
export function StringSplit({
  text,
  mode = "char",
  as: Tag = "span",
  className = "",
  step = 0.03,
  delay = 0,
}) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          el.classList.add("is-in");
          io.disconnect();
        }),
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [text, mode]);

  const words = String(text).split(" ");
  let index = 0;

  return (
    <Tag ref={ref} className={`-splitted str-split ${className}`} aria-label={text}>
      {words.map((word, w) => (
        <span className="-s-word" key={`${word}-${w}`} aria-hidden="true">
          {mode === "word" ? (
            <span
              className="-s-char"
              style={{ "--s-delay": `${delay + index++ * step * 3}s` }}
            >
              {word}
            </span>
          ) : (
            Array.from(word).map((ch, c) => (
              <span
                className="-s-char"
                key={c}
                style={{ "--s-delay": `${delay + index++ * step}s` }}
              >
                {ch}
              </span>
            ))
          )}
          {w < words.length - 1 ? <span className="-s-space">&nbsp;</span> : null}
        </span>
      ))}
    </Tag>
  );
}

/* ------------------------------------------------------------- spotlight
   Pointer-tracked glow. Writes --sx/--sy plus StringTune-style
   --spotlight-angle / --spotlight-distance so CSS can react to direction.  */
export function StringSpotlight({ children, className = "", as: Tag = "div", ...rest }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;

    let frame = 0;
    let pending = null;

    const apply = () => {
      frame = 0;
      if (!pending) return;
      const { x, y } = pending;
      const dx = x - 0.5;
      const dy = y - 0.5;
      el.style.setProperty("--sx", `${(x * 100).toFixed(2)}%`);
      el.style.setProperty("--sy", `${(y * 100).toFixed(2)}%`);
      el.style.setProperty(
        "--spotlight-angle",
        `${((Math.atan2(dy, dx) * 180) / Math.PI + 360).toFixed(1)}deg`
      );
      el.style.setProperty(
        "--spotlight-distance",
        Math.min(1, Math.hypot(dx, dy) * 2).toFixed(3)
      );
    };

    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      pending = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      el.style.setProperty("--spotlight-distance", "0");
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <Tag ref={ref} className={`str-spot ${className}`} {...rest}>
      <span className="str-spot-glow" aria-hidden="true" />
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------ engine chip
   Small honest status pill: shows whether the CDN engine or the bundled
   fallback is driving the page.                                            */
export function StringEngineChip({ className = "" }) {
  const { mode } = useStringEngine();
  const label =
    mode === "library"
      ? "string-tune · cdn"
      : mode === "local"
      ? "string-tune · local"
      : "string-tune · boot";
  return (
    <span className={`str-chip mono xs ${className}`} title="StringTune scroll engine">
      <i aria-hidden="true" />
      {label}
    </span>
  );
}
