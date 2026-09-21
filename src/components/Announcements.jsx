/* ==========================================================================
   Announcements — the site-wide banner strip (v12.7)
   --------------------------------------------------------------------------
   Active rows from public.announcements, rendered between the header and the
   page on every public route. The strip is deliberately a SINGLE banner:
   duplicate messages are filtered out and the remainder are merged into one
   item, so the page never stacks two competing notes under the header.
   Dismissal is remembered per announcement in localStorage, so a hidden
   banner stays hidden until a NEW one is posted. Renders nothing when there
   is nothing to say — and nothing at all when the v12.7 table is missing
   (listAnnouncements degrades to an empty list).
   ========================================================================== */

import React, { useEffect, useState } from "react";
import { listAnnouncements } from "../lib/db.js";
import { isConfigured } from "../lib/supabase.js";

const DISMISS_KEY = "ragestar-announce-dismissed";

function readDismissed() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/* A message is a duplicate when its title AND body both match one we already
   kept (ignoring case and stray whitespace) — repeats collapse to one entry. */
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const a of rows) {
    if (!a || !a.id) continue;
    const key = `${(a.title || "").trim().toLowerCase()}::${(a.body || "")
      .trim()
      .toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export default function Announcements() {
  const [items, setItems] = useState([]);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let alive = true;
    listAnnouncements()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const visible = dedupe(items).filter((a) => !dismissed[a.id]);
  if (!visible.length) return null;

  /* merge everything that is left into the one banner: newest message carries
     the headline, the rest join the body line */
  const [head, ...rest] = visible;
  const merged = [head.body, ...rest.map((a) => a.title)].filter(Boolean).join("  ·  ");

  const dismissAll = () => {
    const next = { ...readDismissed() };
    for (const a of visible) next[a.id] = true;
    setDismissed(next);
    try {
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* private mode — the banner simply comes back next visit */
    }
  };

  return (
    <aside className="ann" aria-label="Announcements">
      <div className={`ann-item ann-${head.tone || "info"}`}>
        <div className="ann-body">
          <b>{head.title}</b>
          {merged ? <span>{merged}</span> : null}
        </div>
        {rest.length ? (
          <span className="ann-count" title="Merged announcements">
            +{rest.length}
          </span>
        ) : null}
        <button
          type="button"
          className="ann-x"
          aria-label="Dismiss announcement"
          onClick={dismissAll}
        >
          {"×"}
        </button>
      </div>
    </aside>
  );
}
