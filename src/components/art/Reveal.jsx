import React, { useEffect, useRef, useState } from "react";

/* ---------------------------------------------------------------------------
   Reveal: adds `rv-in` once an element has actually been seen.

   Self contained on purpose — the SVG draw-on animations, the step rail and
   the section arrivals all key off the same single class, so there is one
   place to reason about entry motion. Elements are revealed permanently
   (no replay on scroll back up, which is what makes scroll effects feel cheap)
   and anything without IntersectionObserver is shown immediately.
--------------------------------------------------------------------------- */

export default function Reveal({
  as: Tag = "div",
  className = "",
  delay = 0,
  children,
  ...rest
}) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return (
    <Tag
      ref={ref}
      data-reveal=""
      className={`${className}${seen ? " rv-in" : ""}`.trim()}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* Headline that arrives one word at a time. Words keep their own box, so the
   line never reflows mid-animation. */
export function Words({ text, accent = [], className = "" }) {
  const words = String(text).split(" ");
  return (
    <span className={`rr-words ${className}`.trim()}>
      {words.map((word, i) => (
        <span
          key={`${word}-${i}`}
          className={`w${accent.includes(i) ? " is-accent" : ""}`}
          style={{ "--i": i }}
        >
          {i < words.length - 1 ? `${word} ` : word}
        </span>
      ))}
    </span>
  );
}
