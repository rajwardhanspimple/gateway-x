/* ==========================================================================
   Models available
   --------------------------------------------------------------------------
   Model ids already look like paths — "ragestar-4-turbo", "ragestar-4-mini" — so
   the catalogue is shown as one. The family becomes the folder, the model the
   file inside it. Selecting a model opens its pricing and limits on the right.
   ========================================================================== */

import React, { useMemo, useState } from "react";
import { Button, TextInput } from "../../components/ui/index.jsx";
import { Explorer, Tree, TreeDetail } from "../../components/ui/Tree.jsx";
import { compact, copy, money } from "../../lib/format.js";
import { Stat, StatusChip, TabHead } from "./parts.jsx";

/**
 * Turns a model id into a folder + leaf name.
 *   "openai/gpt-4o"      -> { dir: "openai",  leaf: "gpt-4o" }
 *   "gpt-4o-mini"        -> { dir: "gpt",     leaf: "gpt-4o-mini" }
 *   "claude-3-5-sonnet"  -> { dir: "claude",  leaf: "claude-3-5-sonnet" }
 * Public ids are deliberately vendor-neutral aliases, so this only ever reads
 * the alias itself — it never exposes which upstream serves the request.
 */
function pathFor(model) {
  const id = String(model?.id ?? "");
  const slash = id.indexOf("/");
  if (slash > 0) {
    return { dir: id.slice(0, slash), leaf: id.slice(slash + 1) || id };
  }
  const head = id.split(/[-_.:]/)[0];
  return { dir: head || "models", leaf: id };
}

export default function ModelsTab({ models = [], gatewayUrl, onRefresh }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(null);
  const [copiedId, setCopiedId] = useState("");

  const folders = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (m) =>
      !needle ||
      [m.id, m.name, m.description, ...(m.capabilities || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);

    const byDir = new Map();
    for (const m of models) {
      if (!match(m)) continue;
      const { dir, leaf } = pathFor(m);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({
        id: m.id,
        name: leaf,
        meta: m.context_window ? compact(m.context_window) : null,
        badge: m.locked
          ? "locked"
          : m.access_tier === "early_access"
            ? "early access"
            : m.status === "active"
              ? null
              : m.status,
        tone: m.locked ? "warn" : m.status === "active" ? "ok" : "warn",
        row: m,
      });
    }

    return [...byDir.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dir, files]) => ({
        id: dir,
        name: `${dir}/`,
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [models, q]);

  const shown = folders.reduce((a, f) => a + f.files.length, 0);
  const selected = models.find((m) => m.id === picked) ?? null;
  const sel = selected ? pathFor(selected) : null;

  const cheapest = models.length
    ? models.reduce((a, b) =>
        Number(a.price_in_per_m) <= Number(b.price_in_per_m) ? a : b
      )
    : null;
  const widest = models.length
    ? models.reduce((a, b) =>
        Number(a.context_window || 0) >= Number(b.context_window || 0) ? a : b
      )
    : null;

  const sample = selected?.id || folders[0]?.files[0]?.id || "your-model-id";

  return (
    <>
      <TabHead
        title="Models available"
        actions={
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        }
      >
        Every id is a public alias, resolved to an upstream server-side.
      </TabHead>

      <div className="adm-stats">
        <Stat label="Published" value={models.length} sub="callable now" />
        <Stat
          label="Active"
          value={models.filter((m) => m.status === "active").length}
          sub="taking traffic"
        />
        <Stat
          label="Early access"
          value={models.filter((m) => m.access_tier === "early_access").length}
          sub={
            models.some((m) => m.locked)
              ? "needs early access on your account"
              : "unlocked for you"
          }
        />
        <Stat
          label="Cheapest in"
          value={cheapest ? money(cheapest.price_in_per_m) : "\u2014"}
          sub={cheapest ? `${cheapest.id} · per 1M` : "none published"}
        />
        <Stat
          label="Largest context"
          value={widest?.context_window ? compact(widest.context_window) : "\u2014"}
          sub={widest?.context_window ? widest.id : "not reported"}
        />
      </div>

      <div className="mt-5">
        <Explorer
          toolbar={
            <>
              <div className="con-search">
                <TextInput
                  placeholder="Filter by id or capability"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Filter models"
                />
              </div>
              <span className="faint xs mono">
                {shown}/{models.length}
              </span>
            </>
          }
        >
          <Tree
            label="Model catalogue"
            folders={folders}
            selectedId={picked}
            onSelect={(id) => setPicked(id)}
          />

          {!selected ? (
            <TreeDetail
              empty={
                models.length === 0
                  ? "Nothing published yet. An admin maps a public id to an upstream first."
                  : "Pick a model to see pricing, limits and its call snippet."
              }
            />
          ) : (
            <TreeDetail
              path={`models/${sel.dir}/${sel.leaf}`}
              title={selected.id}
              sub={selected.name || null}
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await copy(selected.id);
                    setCopiedId(selected.id);
                  }}
                >
                  {copiedId === selected.id ? "Copied" : "Copy id"}
                </Button>
              }
              rows={[
                [
                  "status",
                  <StatusChip value={selected.status === "active" ? "working" : "unknown"} />,
                ],
                [
                  "access",
                  selected.access_tier === "early_access"
                    ? selected.locked
                      ? `early access · not on your account${
                          selected.access_note ? ` — ${selected.access_note}` : ""
                        }`
                      : "early access · enabled for you"
                    : "everyone",
                ],
                [
                  "context",
                  selected.context_window ? compact(selected.context_window) : "\u2014",
                ],
                [
                  "max output",
                  selected.max_output_tokens ? compact(selected.max_output_tokens) : "\u2014",
                ],
                ["input", `${money(selected.price_in_per_m)} / 1M`],
                ["output", `${money(selected.price_out_per_m)} / 1M`],
                selected.capabilities?.length
                  ? ["capabilities", <span className="mono xs">{selected.capabilities.join(" · ")}</span>]
                  : null,
                selected.description ? ["notes", selected.description] : null,
              ]}
            />
          )}
        </Explorer>
      </div>

      <div className="adm-card mt-4">
        <h3>Calling it</h3>
        <p className="sub">Same body as the OpenAI API. Only the base URL and key change.</p>
        <pre className="con-code mono xs">{`curl ${gatewayUrl || "<your gateway>"}/chat/completions \\
  -H "authorization: Bearer rs_live_…" \\
  -H "content-type: application/json" \\
  -d '{"model":"${sample}","messages":[{"role":"user","content":"hi"}]}'`}</pre>
      </div>
    </>
  );
}
