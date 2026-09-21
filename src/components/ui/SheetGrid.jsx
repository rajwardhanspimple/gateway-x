/* SheetGrid - a spreadsheet, not a list.
   Column letters, row numbers, a formula bar, a frozen header, click-to-sort,
   a filter box, a totals row, arrow-key selection, copy cell / row, CSV export.

   columns: { key, label, width?, type?, mono?, total?, render? }
   type: text | int | number | tokens | money | ms | datetime | bool */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { compact, dateTime, money, ms, num } from "../../lib/format.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function letterFor(i) {
  return i < 26 ? LETTERS[i] : `${LETTERS[Math.floor(i / 26) - 1]}${LETTERS[i % 26]}`;
}

function isNumeric(type) {
  return type === "int" || type === "number" || type === "tokens" || type === "money" || type === "ms";
}

function cellText(col, row) {
  const v = row?.[col.key];
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "money") return money(Number(v), 4);
  if (col.type === "tokens") return Number(v) >= 100000 ? compact(Number(v)) : num(Number(v));
  if (col.type === "int" || col.type === "number") return num(Number(v));
  if (col.type === "ms") return ms(Number(v));
  if (col.type === "datetime") return dateTime(v);
  if (col.type === "bool") return v ? "true" : "false";
  return String(v);
}

function sortValue(col, row) {
  const v = row?.[col.key];
  if (v === null || v === undefined || v === "") return isNumeric(col.type) ? -Infinity : "";
  if (isNumeric(col.type)) return Number(v) || 0;
  if (col.type === "bool") return v ? 1 : 0;
  if (col.type === "datetime") return new Date(v).getTime() || 0;
  return String(v).toLowerCase();
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function SheetGrid({
  title = "Sheet",
  subtitle = "",
  columns = [],
  rows = [],
  loading = false,
  filename = "sheet.csv",
  emptyLabel = "Nothing here yet.",
  maxHeight = 520,
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: null, dir: "desc" });
  const [cursor, setCursor] = useState({ r: 0, c: 0 });
  const [copied, setCopied] = useState("");

  const cols = useMemo(() => columns.filter(Boolean), [columns]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => cols.some((col) => cellText(col, row).toLowerCase().includes(q)));
  }, [rows, cols, query]);

  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(col, a);
      const bv = sortValue(col, b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [filtered, sort, cols]);

  const totals = useMemo(() => {
    const out = {};
    for (const col of cols) {
      if (!isNumeric(col.type) || col.total === false) continue;
      out[col.key] = sorted.reduce((a, row) => a + (Number(row?.[col.key]) || 0), 0);
    }
    return out;
  }, [sorted, cols]);

  useEffect(() => {
    setCursor((cur) => ({
      r: Math.min(cur.r, Math.max(sorted.length - 1, 0)),
      c: Math.min(cur.c, Math.max(cols.length - 1, 0)),
    }));
  }, [sorted.length, cols.length]);

  const copy = useCallback(async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 1400);
    } catch {
      setCopied("");
    }
  }, []);

  const onKeyDown = useCallback(
    (event) => {
      const mod = event.metaKey || event.ctrlKey;
      const row = sorted[cursor.r];
      if (mod && (event.key === "c" || event.key === "C")) {
        if (!row) return;
        event.preventDefault();
        if (event.shiftKey) copy(cols.map((col) => cellText(col, row)).join("\t"), "row");
        else copy(cellText(cols[cursor.c], row), "cell");
        return;
      }
      const moves = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        PageUp: [-10, 0],
        PageDown: [10, 0],
      };
      if (!moves[event.key]) return;
      event.preventDefault();
      const [dr, dc] = moves[event.key];
      setCursor((cur) => ({
        r: Math.max(0, Math.min(sorted.length - 1, cur.r + dr)),
        c: Math.max(0, Math.min(cols.length - 1, cur.c + dc)),
      }));
    },
    [sorted, cursor, cols, copy],
  );

  function toggleSort(key) {
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  function exportCsv() {
    const head = cols.map((col) => csvCell(col.label ?? col.key)).join(",");
    const body = sorted.map((row) => cols.map((col) => csvCell(row?.[col.key])).join(","));
    const url = URL.createObjectURL(new Blob([[head, ...body].join("\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const activeRow = sorted[cursor.r];
  const activeCol = cols[cursor.c];
  const address = activeCol ? `${letterFor(cursor.c)}${cursor.r + 1}` : "-";
  const activeValue = activeRow && activeCol ? cellText(activeCol, activeRow) : "";
  const hasTotals = Object.keys(totals).length > 0;

  return (
    <section className="sheet" aria-label={title}>
      <header className="sheet-head">
        <div className="sheet-heading">
          <span className="sheet-title">{title}</span>
          {subtitle ? <span className="sheet-sub">{subtitle}</span> : null}
        </div>
        <div className="sheet-tools">
          <input
            className="sheet-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter rows"
            aria-label="Filter rows"
          />
          <button type="button" className="sheet-btn" onClick={exportCsv} disabled={!sorted.length}>
            Export CSV
          </button>
        </div>
      </header>

      <div className="sheet-bar">
        <span className="sheet-addr">{address}</span>
        <span className="sheet-value">{activeValue || (loading ? "loading" : "")}</span>
        <span className="sheet-hint">
          {copied ? `${copied} copied` : `${num(sorted.length)} rows / cmd+C cell / shift+cmd+C row`}
        </span>
      </div>

      <div className="sheet-scroll" style={{ maxHeight }} tabIndex={0} role="grid" onKeyDown={onKeyDown}>
        <table className="sheet-table">
          <thead>
            <tr className="sheet-letters">
              <th className="sheet-corner" />
              {cols.map((col, i) => (
                <th key={`letter-${col.key}`} style={{ width: col.width || 120 }}>
                  {letterFor(i)}
                </th>
              ))}
            </tr>
            <tr className="sheet-headrow">
              <th className="sheet-corner">#</th>
              {cols.map((col) => (
                <th
                  key={col.key}
                  className={`sheet-th${isNumeric(col.type) ? " num" : ""}${sort.key === col.key ? " sorted" : ""}`}
                  style={{ width: col.width || 120 }}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label ?? col.key}
                  <span className="sheet-sort">
                    {sort.key === col.key ? (sort.dir === "asc" ? "asc" : "desc") : ""}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, r) => (
              <tr
                key={row?.request_id || row?.public_id || row?.id || r}
                className={r === cursor.r ? "sheet-activerow" : ""}
              >
                <th className="sheet-rownum">{r + 1}</th>
                {cols.map((col, c) => (
                  <td
                    key={col.key}
                    className={`sheet-td${isNumeric(col.type) ? " num" : ""}${col.mono ? " mono" : ""}${
                      r === cursor.r && c === cursor.c ? " sheet-sel" : ""
                    }`}
                    style={{ width: col.width || 120 }}
                    onClick={() => setCursor({ r, c })}
                    onDoubleClick={() => copy(cellText(col, row), "cell")}
                    title={cellText(col, row)}
                  >
                    {col.render ? col.render(row) : cellText(col, row)}
                  </td>
                ))}
              </tr>
            ))}
            {!sorted.length ? (
              <tr>
                <td className="sheet-empty" colSpan={cols.length + 1}>
                  {loading ? "Loading..." : emptyLabel}
                </td>
              </tr>
            ) : null}
          </tbody>
          {hasTotals && sorted.length ? (
            <tfoot>
              <tr className="sheet-totals">
                <th className="sheet-rownum">S</th>
                {cols.map((col) => (
                  <td key={col.key} className={`sheet-td${isNumeric(col.type) ? " num" : ""}`}>
                    {col.key in totals ? cellText(col, { [col.key]: totals[col.key] }) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </section>
  );
}
