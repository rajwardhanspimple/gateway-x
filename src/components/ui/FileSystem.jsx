import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ============================================================================
   FileSystem — browse upstream APIs, their keys and their models as a tree.
   ----------------------------------------------------------------------------
   The gateway's configuration is already shaped like a filesystem, so it is
   shown as one:

     providers/
       openai-main/
         config                     <- base url, auth scheme, deadline
         keys/
           primary                  <- status, timeouts, cooldown
           backup
         models/
           gpt-4o                   <- public id, pricing, deadline

   Nodes are plain objects, so any screen can build its own tree:

     { path, name, kind: "dir" | "file", meta, badge, tone, data, children }

   Keyboard: up/down walks the visible rows, right/left opens and closes a
   folder (or jumps to the parent), Enter selects. Only one row is tabbable at
   a time, which is what a tree is supposed to do.
============================================================================ */

function flatten(nodes, expanded, depth = 0, out = []) {
  for (const node of nodes || []) {
    const isDir = node.kind === "dir";
    const open = isDir && expanded.has(node.path);
    out.push({ node, depth, open, isDir });
    if (open && node.children?.length) flatten(node.children, expanded, depth + 1, out);
  }
  return out;
}

function collectDirs(nodes, maxDepth, depth = 0, out = []) {
  for (const node of nodes || []) {
    if (node.kind !== "dir") continue;
    if (depth <= maxDepth) out.push(node.path);
    if (node.children?.length) collectDirs(node.children, maxDepth, depth + 1, out);
  }
  return out;
}

function parentPath(path) {
  const i = String(path || "").lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : null;
}

export function FileSystem({
  nodes = [],
  selectedPath,
  onSelect,
  title = "File system",
  toolbar,
  children, // the detail pane
  defaultOpenDepth = 1,
  emptyLabel = "Nothing to browse yet.",
}) {
  const [expanded, setExpanded] = useState(() => new Set(collectDirs(nodes, defaultOpenDepth)));
  const [focusPath, setFocusPath] = useState(selectedPath || null);
  const listRef = useRef(null);

  /* New folders (a provider was just added) start open at the top level so the
     tree never looks empty after an edit. */
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of collectDirs(nodes, 0)) if (!next.has(p)) next.add(p);
      return next;
    });
  }, [nodes]);

  /* Reveal whatever is selected from outside (e.g. after "open in file system"). */
  useEffect(() => {
    if (!selectedPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let p = parentPath(selectedPath);
      while (p) {
        next.add(p);
        p = parentPath(p);
      }
      return next;
    });
    setFocusPath(selectedPath);
  }, [selectedPath]);

  const visible = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const focusIndex = Math.max(
    visible.findIndex((r) => r.node.path === focusPath),
    0,
  );

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activate = useCallback(
    (row) => {
      setFocusPath(row.node.path);
      if (row.isDir) toggle(row.node.path);
      if (onSelect) onSelect(row.node);
    },
    [onSelect, toggle],
  );

  const move = (delta) => {
    if (!visible.length) return;
    const next = Math.min(Math.max(focusIndex + delta, 0), visible.length - 1);
    const path = visible[next].node.path;
    setFocusPath(path);
    const el = listRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`);
    el?.focus();
  };

  const onKeyDown = (e, row) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (row.isDir && !row.open) toggle(row.node.path);
      else move(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (row.isDir && row.open) {
        toggle(row.node.path);
        return;
      }
      const parent = parentPath(row.node.path);
      if (parent) {
        const at = visible.findIndex((r) => r.node.path === parent);
        if (at >= 0) {
          setFocusPath(parent);
          listRef.current
            ?.querySelector(`[data-path="${CSS.escape(parent)}"]`)
            ?.focus();
        }
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(row);
    }
  };

  return (
    <div className="fsx">
      <div className="fsx-bar">
        <span className="fsx-title">{title}</span>
        <span className="fsx-meta">
          {visible.length} {visible.length === 1 ? "entry" : "entries"} shown
        </span>
        {toolbar ? <span className="fsx-spacer" /> : null}
        {toolbar}
      </div>

      <div className="fsx-split">
        <div className="fsx-tree" ref={listRef}>
          {visible.length === 0 ? (
            <p className="fsx-empty">{emptyLabel}</p>
          ) : (
            <div className="fsx-rows" role="tree" aria-label={title}>
              {visible.map((row, i) => {
                const { node, depth, open, isDir } = row;
                const on = node.path === selectedPath;
                return (
                  <button
                    key={node.path}
                    type="button"
                    role="treeitem"
                    data-path={node.path}
                    aria-level={depth + 1}
                    aria-expanded={isDir ? open : undefined}
                    aria-selected={on}
                    tabIndex={i === focusIndex ? 0 : -1}
                    className={`fsx-row${isDir ? " is-dir" : ""}${on ? " is-on" : ""}`}
                    style={{ paddingLeft: 8 + depth * 14 }}
                    onClick={() => activate(row)}
                    onKeyDown={(e) => onKeyDown(e, row)}
                    onFocus={() => setFocusPath(node.path)}
                  >
                    <span className="fsx-caret" aria-hidden="true">
                      {isDir ? (open ? "▾" : "▸") : ""}
                    </span>
                    <span className="fsx-icon" aria-hidden="true">
                      {isDir ? (open ? "─" : "+") : "·"}
                    </span>
                    <span className="fsx-name">{node.name}</span>
                    {node.badge ? (
                      <span className={`fsx-badge${node.tone ? ` is-${node.tone}` : ""}`}>
                        {node.badge}
                      </span>
                    ) : null}
                    {node.meta ? <span className="fsx-meta">{node.meta}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="fsx-detail">{children}</div>
      </div>
    </div>
  );
}

/* The right-hand pane: a path, a title and whatever the screen wants below. */
export function FileDetail({ path, title, sub, actions, children, empty }) {
  if (!path && !title) {
    return <p className="fsx-empty">{empty || "Select something on the left."}</p>;
  }
  return (
    <div>
      {path ? <p className="fsx-path">{path}</p> : null}
      {title ? <h3>{title}</h3> : null}
      {sub ? <p className="fsx-sub">{sub}</p> : null}
      {actions ? <div className="fsx-detail-actions">{actions}</div> : null}
      {children}
    </div>
  );
}

/* A labelled block inside the detail pane, so sections line up everywhere. */
export function FileSection({ title, children }) {
  return (
    <section className="fsx-sec">
      {title ? <h4>{title}</h4> : null}
      {children}
    </section>
  );
}

/* Key/value table — the tabular default for a single record. */
export function KeyValues({ rows = [] }) {
  const clean = rows.filter(Boolean);
  if (!clean.length) return null;
  return (
    <table className="mn-kv">
      <tbody>
        {clean.map(([k, v], i) => (
          <tr key={`${k}-${i}`}>
            <th scope="row">{k}</th>
            <td>{v === null || v === undefined || v === "" ? "—" : v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default FileSystem;
