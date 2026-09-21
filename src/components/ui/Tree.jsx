/* ==========================================================================
   Tree — a file-explorer for things that are not files
   --------------------------------------------------------------------------
   Keys and models both have the same shape as a filesystem: a handful of
   groups (environments, providers) each holding a list of leaves. A table
   flattens that and makes you read the grouping column on every row; a tree
   shows it once, in the indent.

   Folders collapse. One leaf is selected at a time and its detail renders
   beside the tree. Nothing here knows what a key or a model is — callers pass
   plain data and get clicks back.
   ========================================================================== */

import React, { useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------------------------------------- iconography */

function Chevron({ open }) {
  return (
    <svg
      className={`tr-chev ${open ? "is-open" : ""}`}
      viewBox="0 0 12 12"
      width={12}
      height={12}
      aria-hidden="true"
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open }) {
  return (
    <svg className="tr-ico" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
      {open ? (
        <path
          d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3l1.3 1.5h6c.6 0 1.1.5 1.1 1.1v.5H3.4L1.5 12z"
          fill="currentColor"
          opacity="0.85"
        />
      ) : (
        <path
          d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3l1.3 1.5h6c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"
          fill="currentColor"
          opacity="0.85"
        />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="tr-ico" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
      <path
        d="M4 1.8h5L12.2 5v9.2c0 .3-.3.6-.6.6H4.4a.6.6 0 0 1-.6-.6V2.4c0-.3.3-.6.6-.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M8.8 2v3.1h3.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/* --------------------------------------------------------------------- tree */

/**
 * @param folders  [{ id, name, meta, badge, tone, files: [{ id, name, meta, badge, tone }] }]
 * @param selectedId  id of the highlighted leaf
 * @param onSelect    (fileId, file, folder) => void
 * @param openIds     optional controlled set of open folder ids
 */
export function Tree({
  folders = [],
  selectedId = null,
  onSelect = () => {},
  label = "Tree",
  footer = null,
}) {
  /* Folders start open. A folder the user closed stays closed even when the
     data reloads, so a background refresh never re-expands the whole tree. */
  const [closed, setClosed] = useState(() => new Set());
  const listRef = useRef(null);

  const toggle = (id) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /* Keep the selected leaf reachable: if it lives in a folder the user closed,
     open that folder rather than hiding the current selection. */
  useEffect(() => {
    if (!selectedId) return;
    const owner = folders.find((f) => f.files?.some((x) => x.id === selectedId));
    if (owner && closed.has(owner.id)) {
      setClosed((prev) => {
        const next = new Set(prev);
        next.delete(owner.id);
        return next;
      });
    }
  }, [selectedId, folders]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Roving focus: up/down walk visible rows, left/right collapse/expand. */
  const onKeyDown = (e) => {
    const rows = Array.from(listRef.current?.querySelectorAll("[data-tr-row]") ?? []);
    const here = rows.indexOf(document.activeElement);
    if (here < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows[Math.min(here + 1, rows.length - 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.max(here - 1, 0)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      rows[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      rows[rows.length - 1]?.focus();
    }
  };

  return (
    <div className="tr" role="tree" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {folders.map((folder) => {
        const open = !closed.has(folder.id);
        const files = folder.files ?? [];
        return (
          <div className="tr-group" key={folder.id} role="none">
            <button
              type="button"
              data-tr-row
              role="treeitem"
              aria-expanded={open}
              className="tr-folder"
              onClick={() => toggle(folder.id)}
            >
              <Chevron open={open} />
              <FolderIcon open={open} />
              <span className="tr-name">{folder.name}</span>
              {folder.meta ? <span className="tr-meta">{folder.meta}</span> : null}
              <span className="tr-count">{files.length}</span>
            </button>

            {open ? (
              <div className="tr-children" role="group">
                {files.length === 0 ? (
                  <div className="tr-empty">empty</div>
                ) : (
                  files.map((file) => (
                    <button
                      type="button"
                      key={file.id}
                      data-tr-row
                      role="treeitem"
                      aria-selected={selectedId === file.id}
                      className={`tr-file ${selectedId === file.id ? "is-on" : ""}`}
                      onClick={() => onSelect(file.id, file, folder)}
                    >
                      <FileIcon />
                      <span className="tr-name mono">{file.name}</span>
                      {file.meta ? <span className="tr-meta">{file.meta}</span> : null}
                      {file.badge ? (
                        <span className={`tr-badge ${file.tone ? `is-${file.tone}` : ""}`}>
                          {file.badge}
                        </span>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      {footer ? <div className="tr-foot">{footer}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- detail */

/** The right-hand pane. `rows` is [[label, value], …]; falsy rows are dropped. */
export function TreeDetail({ path, title, sub, rows = [], actions = null, children, empty }) {
  if (empty) {
    return (
      <div className="tr-detail is-empty">
        <p className="faint small">{empty}</p>
      </div>
    );
  }
  return (
    <div className="tr-detail">
      {path ? <div className="tr-path mono xs">{path}</div> : null}
      <div className="tr-detail-head">
        <div>
          <h4 className="mono">{title}</h4>
          {sub ? <p className="faint xs">{sub}</p> : null}
        </div>
        {actions ? <div className="acts">{actions}</div> : null}
      </div>
      {rows.filter(Boolean).length ? (
        <dl className="tr-rows">
          {rows.filter(Boolean).map(([k, v]) => (
            <div className="tr-row" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

/** Tree on the left, detail on the right. Stacks under ~900px. */
export function Explorer({ toolbar = null, children }) {
  return (
    <div className="tr-shell">
      {toolbar ? <div className="tr-toolbar">{toolbar}</div> : null}
      <div className="tr-split">{children}</div>
    </div>
  );
}

/** Groups a flat list into folders by a key function. */
export function useFolders(items, keyOf, deps = []) {
  return useMemo(() => {
    const map = new Map();
    for (const item of items ?? []) {
      const key = keyOf(item) || "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  }, [items, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
