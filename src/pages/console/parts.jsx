/* ==========================================================================
   Console shared parts
   --------------------------------------------------------------------------
   Small presentational helpers used by more than one console tab. Keeping
   them here means each tab file stays about its own screen.
   ========================================================================== */

import React from "react";
import { shortDate } from "../../lib/format.js";

/* ---------------------------------------------------------------- sparkline */
export function Spark({ points = [], height = 74 }) {
  if (!points.length) return null;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? 100 / (points.length - 1) : 100;
  const d = points
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(100 - (v / max) * 92).toFixed(2)}`
    )
    .join(" ");
  return (
    <svg
      className="spark-svg"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden="true"
    >
      <path d={`${d} L100,100 L0,100 Z`} fill="currentColor" opacity="0.12" />
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* -------------------------------------------------------------- status chip */
export function StatusChip({ value }) {
  return (
    <span className={`st st-${value || "unknown"}`}>
      {(value || "unknown").replace(/_/g, " ")}
    </span>
  );
}

/* ------------------------------------------------------------- daily volume */
export function Bars({ days = [], height = 62 }) {
  if (!days.length) return null;
  const max = Math.max(1, ...days.map((d) => Number(d.requests) || 0));
  return (
    <div className="uptime-bars" style={{ height }}>
      {days.map((d) => {
        const total = Number(d.requests) || 0;
        const failed = Number(d.failed) || 0;
        const h = total === 0 ? 4 : Math.max(6, Math.round((total / max) * height));
        const tone =
          total === 0
            ? "var(--border-strong)"
            : failed === 0
            ? "#37c489"
            : failed / total > 0.1
            ? "#e5484d"
            : "#e8a13a";
        return (
          <span
            key={d.day}
            title={`${shortDate(d.day)} · ${total} requests · ${failed} failed`}
            style={{ height: h, background: tone, opacity: total === 0 ? 0.5 : 1 }}
          />
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- empty state */
export function Empty({ title, children, action = null }) {
  return (
    <div className="adm-empty">
      <b>{title}</b>
      {children}
      {action ? <div className="adm-form-actions">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------- stat cards */
export function Stat({ label, value, sub, tone }) {
  return (
    <div className="adm-stat" data-tone={tone || undefined}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------- section title block */
export function TabHead({ title, children, actions = null }) {
  return (
    <div className="adm-head">
      <div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions ? <div className="adm-head-actions">{actions}</div> : null}
    </div>
  );
}
