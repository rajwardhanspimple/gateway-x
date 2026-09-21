/* ==========================================================================
   Admin parts — the small pieces every heavy tab needed and none of them had
   --------------------------------------------------------------------------
   The console has had a parts.jsx since v8; the admin panel never did, which
   is why each tab grew its own slightly different search box and none of them
   remembered anything. These are deliberately dumb components with no data
   access of their own, so a tab can adopt one without inheriting a fetch.

   Every filter reads and writes localStorage under its own key, so coming
   back to a tab shows the view you left rather than a reset.
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ state */

function readStored(key, fallback) {
  if (!key) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One filter state object, persisted.
 *
 *   const [f, set, reset, dirty] = useFilters("rs-adm-keys", { q: "", state: "all" })
 *   set("q", "openai")   → f.q === "openai", written to localStorage
 */
export function useFilters(storageKey, initial) {
  const base = useMemo(() => initial || {}, [initial]);
  const [value, setValue] = useState(() => readStored(storageKey, base));

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* private mode: filters simply stop persisting */
    }
  }, [storageKey, value]);

  const set = useCallback((patch, maybeValue) => {
    setValue((prev) =>
      typeof patch === "string" ? { ...prev, [patch]: maybeValue } : { ...prev, ...patch },
    );
  }, []);

  const reset = useCallback(() => setValue(base), [base]);

  const dirty = useMemo(
    () => Object.keys(base).some((k) => String(value[k] ?? "") !== String(base[k] ?? "")),
    [base, value],
  );

  return [value, set, reset, dirty];
}

/* ---------------------------------------------------------------- matching */

/** Case-insensitive "does any of this row contain the words typed". Each word
 *  must appear somewhere, in any field — typing `openai failing` narrows to
 *  rows that mention both, which is how people actually search a table. */
export function matchText(query, ...fields) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = fields
    .filter((f) => f !== null && f !== undefined)
    .map((f) => String(f).toLowerCase())
    .join(" \u0001 ");
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Window filters: "1h", "24h", "7d", "30d", "all". */
export function withinWindow(value, window) {
  if (!window || window === "all") return true;
  const when = value ? new Date(value).getTime() : 0;
  if (!when) return false;
  const hours = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 }[window];
  if (!hours) return true;
  return Date.now() - when <= hours * 3600_000;
}

export const WINDOWS = [
  { id: "1h", label: "1h" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

/* --------------------------------------------------------------- controls */

export function SearchField({ value, onChange, placeholder = "Search…", autoFocus = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  return (
    <input
      ref={ref}
      type="search"
      className="input ap-grow ap-search"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      /* Escape clears rather than blurs: a filter you cannot see is worse
         than no filter, and this is the fastest way back to "everything". */
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.preventDefault();
          onChange("");
        }
      }}
    />
  );
}

export function Chips({ options, value, onChange, allowAll = true, allLabel = "All" }) {
  const list = allowAll ? [{ id: "all", label: allLabel }, ...options] : options;
  return (
    <div className="ap-chips" role="group">
      {list.map((o) => (
        <button
          key={o.id}
          type="button"
          className="ap-chip"
          aria-pressed={String(value ?? "all") === String(o.id)}
          onClick={() => onChange(o.id)}
        >
          {o.label}
          {o.count !== undefined ? <span className="ap-muted"> {o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SelectField({ label, value, onChange, options }) {
  return (
    <label className="ap-field">
      {label ? <span>{label}</span> : null}
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The strip above a table: search, chips, selects, then the count. */
export function FilterBar({ children, showing, total, onReset, dirty }) {
  return (
    <div className="ap-filters">
      {children}
      <span className="ap-result">
        {showing === total ? `${total} rows` : `${showing} of ${total}`}
        {dirty && onReset ? (
          <button type="button" className="ap-chip" style={{ marginLeft: 8 }} onClick={onReset}>
            Clear
          </button>
        ) : null}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------- dashboard */

export function Kpi({ label, value, sub, tone }) {
  return (
    <div className={`ap-kpi${tone ? ` is-${tone}` : ""}`}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export function Panel({ title, sub, action, children }) {
  return (
    <section className="ap-panel">
      <header>
        <h3>{title}</h3>
        {sub ? <span className="ap-sub">{sub}</span> : null}
        {action ? <span className="ap-act">{action}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Segments are `[{ tone, value }]`; zero-width slices are dropped so a bar
 *  never renders a hairline that suggests a count that is not there. */
export function Bar({ segments }) {
  const total = segments.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  if (!total) return <div className="ap-bar"><i className="idle" style={{ width: "100%" }} /></div>;
  return (
    <div className="ap-bar">
      {segments
        .filter((s) => Number(s.value) > 0)
        .map((s, i) => (
          <i
            key={`${s.tone}-${i}`}
            className={s.tone || "idle"}
            style={{ width: `${((Number(s.value) || 0) / total) * 100}%` }}
            title={`${s.label || s.tone}: ${s.value}`}
          />
        ))}
    </div>
  );
}

export function LiveDot({ state }) {
  return <span className={`ap-dot is-${state || "off"}`} aria-hidden="true" />;
}

export function Empty({ children }) {
  return <div className="ap-empty">{children}</div>;
}

export function Row({ label, value, segments }) {
  return (
    <div className="ap-row">
      <span className="ap-row-label">{label}</span>
      <span className="ap-row-track">{segments ? <Bar segments={segments} /> : null}</span>
      <span className="ap-row-value">{value}</span>
    </div>
  );
}
