import React, { useEffect, useState } from "react";

/* ---------------------------------------------------------------------------
   Boot screen.

   The previous version printed a fake console log — edge regions, provider
   counts, a "semantic cache WARM" line — none of which the app knows at boot.
   It is gone. What is left is honest: the brand mark draws itself once, a
   hairline reports real elapsed progress, and the panel wipes away.
--------------------------------------------------------------------------- */

const DURATION = 820;

export default function Preloader({ onDone }) {
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const total = reduced ? 120 : DURATION;
    let raf = 0;
    let timer = 0;
    const start = performance.now();

    const tick = (now) => {
      const k = Math.min(1, (now - start) / total);
      setProgress(k);
      if (k < 1) {
        raf = requestAnimationFrame(tick);
        return;
      }
      setLeaving(true);
      timer = window.setTimeout(() => onDone && onDone(), reduced ? 60 : 700);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [onDone]);

  return (
    <div className={`boot ${leaving ? "is-done" : ""}`} role="status" aria-label="Loading">
      <div className="boot-inner boot-stack">
        <svg className="boot-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="bootg" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4fe3ff" />
              <stop offset="1" stopColor="#8f7bff" />
            </linearGradient>
          </defs>
          <rect
            className="bm-draw"
            x="1.15"
            y="1.15"
            width="29.7"
            height="29.7"
            rx="9.2"
            pathLength="1"
            stroke="url(#bootg)"
            strokeWidth="1.3"
          />
          <path
            className="bm-draw d2"
            d="M11.4 15.1 20.5 10.1M11.5 16h9.1M11.4 16.9l9.1 5"
            pathLength="1"
            stroke="url(#bootg)"
            strokeWidth="1.45"
            strokeLinecap="round"
          />
          <circle className="bm-fade" cx="8.6" cy="16" r="2.7" fill="url(#bootg)" />
          <circle className="bm-fade" cx="22.9" cy="9.6" r="2.05" fill="#4fe3ff" />
          <circle className="bm-fade" cx="22.9" cy="16" r="2.05" fill="#8f7bff" />
          <circle className="bm-fade" cx="22.9" cy="22.4" r="2.05" fill="#4fe3ff" fillOpacity="0.72" />
        </svg>

        <div className="boot-prog" aria-hidden="true">
          <i style={{ transform: `scaleX(${progress})` }} />
        </div>

        <p className="boot-line">RageStar</p>
      </div>
    </div>
  );
}
