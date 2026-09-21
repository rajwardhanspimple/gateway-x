import React, { useMemo, useState } from "react";

/* ============================================================================
   DataTable — the default way this app shows anything countable.
   ----------------------------------------------------------------------------
   Rows in, table out: sorting, filtering, paging and the empty state all live
   here so every screen behaves the same way and no screen re-invents a table.

   columns: [{
     key,                 // property name on the row (also the column id)
     label,               // header text
     render(row),         // optional custom cell
     value(row),          // optional value used for sorting + filtering
     align: "right",      // right-aligns and uses tabular numerals
     mono: true,          // monospace cell
     wrap: true,          // let the cell wrap instead of staying on one line
     sortable: false,     // opt out of sorting (default is sortable)
     width: 120,          // px hint
   }]

   Everything is client-side: these tables show admin-sized lists (hundreds of
   rows), so filtering in the browser keeps it instant and avoids a round trip
   for every keystroke.
============================================================================ */

function valueOf(col, row) {
  if (typeof col.value === "function") return col.value(row);
  if (col.key != null && row && typeof row === "object") return row[col.key];
  return undefined;
}

function textOf(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function compare(a, b) {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // blanks always sink
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export default function DataTable({
  columns = [],
  rows = [],
  getKey,
  caption,
  empty = "Nothing here yet.",
  search = false,
  searchPlaceholder = "Filter…",
  initialSort, // { key, dir: "asc" | "desc" }
  dense = false,
  pageSize = 0, // 0 = show everything
  maxHeight, // e.g. 480 -> scrolls inside the card
  onRowClick,
  selectedKey,
  toolbar,
  footNote,
  className = "",
}) {
  const cols = useMemo(() => columns.filter(Boolean), [columns]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(initialSort || null);
  const [page, setPage] = useState(0);

  const keyFor = (row, i) => {
    if (typeof getKey === "function") return getKey(row, i);
    return row?.id ?? row?.key ?? row?.path ?? i;
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      cols.some((col) => textOf(valueOf(col, row)).toLowerCase().includes(needle)),
    );
  }, [rows, cols, q]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = cols.find((c) => (c.key ?? c.label) === sort.key);
    if (!col) return filtered;
    const out = [...filtered].sort((x, y) => compare(valueOf(col, x), valueOf(col, y)));
    return sort.dir === "desc" ? out.reverse() : out;
  }, [filtered, sort, cols]);

  const pages = pageSize > 0 ? Math.max(Math.ceil(sorted.length / pageSize), 1) : 1;
  const current = Math.min(page, pages - 1);
  const visible =
    pageSize > 0 ? sorted.slice(current * pageSize, current * pageSize + pageSize) : sorted;

  const toggleSort = (col) => {
    const id = col.key ?? col.label;
    setPage(0);
    setSort((prev) => {
      if (!prev || prev.key !== id) return { key: id, dir: "asc" };
      if (prev.dir === "asc") return { key: id, dir: "desc" };
      return null; // third click restores the incoming order
    });
  };

  const showBar = search || toolbar || caption;

  return (
    <div className={`dt-wrap ${className}`.trim()}>
      {showBar ? (
        <div className="dt-bar">
          {caption ? <span className="dt-cap">{caption}</span> : null}
          {search ? (
            <input
              className="dt-search"
              type="search"
              value={q}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
            />
          ) : null}
          <span className="dt-meta">
            {filtered.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}`
              : `${filtered.length} of ${rows.length}`}
          </span>
          {toolbar ? <span className="dt-tools">{toolbar}</span> : null}
        </div>
      ) : null}

      <div className="dt-scroll" style={maxHeight ? { maxHeight } : undefined}>
        <table
          className={`dt${dense ? " is-dense" : ""}${onRowClick ? " is-clickable" : ""}`}
        >
          <thead>
            <tr>
              {cols.map((col) => {
                const id = col.key ?? col.label;
                const on = sort?.key === id;
                const sortable = col.sortable !== false;
                return (
                  <th
                    key={id}
                    className={col.align === "right" ? "is-num" : ""}
                    style={col.width ? { width: col.width } : undefined}
                    aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    scope="col"
                  >
                    {sortable ? (
                      <button type="button" className="dt-h" onClick={() => toggleSort(col)}>
                        <span>{col.label}</span>
                        {on ? (
                          <span className="dt-arrow" aria-hidden="true">
                            {sort.dir === "asc" ? "▲" : "▼"}
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <span className="dt-h">{col.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td className="dt-empty" colSpan={cols.length || 1}>
                  {q.trim() ? `No rows match “${q.trim()}”.` : empty}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => {
                const rk = keyFor(row, i);
                return (
                  <tr
                    key={rk}
                    className={selectedKey != null && selectedKey === rk ? "is-on" : ""}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {cols.map((col) => {
                      const id = col.key ?? col.label;
                      const cls = [
                        col.align === "right" ? "is-num" : "",
                        col.mono ? "is-mono" : "",
                        col.wrap ? "is-wrap" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const content =
                        typeof col.render === "function"
                          ? col.render(row)
                          : textOf(valueOf(col, row)) || "—";
                      return (
                        <td key={id} className={cls}>
                          {content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageSize > 0 && pages > 1 ? (
        <div className="dt-pager">
          <button type="button" onClick={() => setPage(0)} disabled={current === 0}>
            First
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(p - 1, 0))}
            disabled={current === 0}
          >
            Prev
          </button>
          <span>
            Page {current + 1} of {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(p + 1, pages - 1))}
            disabled={current >= pages - 1}
          >
            Next
          </button>
        </div>
      ) : null}

      {footNote ? <p className="dt-foot">{footNote}</p> : null}
    </div>
  );
}

/* Small helpers screens use inside cells, kept here so the look stays shared. */
export function Chip({ tone = "", children }) {
  const cls = tone ? `dt-chip is-${tone}` : "dt-chip";
  return <span className={cls}>{children}</span>;
}

export function CellRow({ children }) {
  return <span className="dt-cellrow">{children}</span>;
}
