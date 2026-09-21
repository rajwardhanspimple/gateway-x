import React, { useEffect, useMemo, useState } from "react";
import { FileSystem, FileDetail, FileSection, KeyValues } from "../../components/ui/FileSystem";
import DataTable from "../../components/ui/DataTable";
import { Button } from "../../components/ui";
import { copy, money, ms, num, relative } from "../../lib/format";
import {
  clearKeyCooldown,
  listAdminModels,
  listKeyChecks,
  listKeyRotation,
  listProviderHealth,
  listUpstreamKeys,
  listUpstreams,
  revealUpstreamKey,
  setModelTimeout,
  setUpstreamKeyStatus,
  setUpstreamTimeout,
  TIMEOUTS_UPGRADE_FILE,
  updateUpstreamKey,
} from "../../lib/db";

/* ============================================================================
   File system
   ----------------------------------------------------------------------------
   The gateway's configuration already forms a tree, so it is browsed as one:

       providers/
         openai-main/
           config            base url, auth, how long to wait
           keys/primary      status, stalls, cooldown
           models/gpt-4o     ids, price, how long to wait
       models/
         gpt-4o              same model, listed flat for lookup

   Folders show tables (every child at a glance); files show one record as a
   key/value table plus the few actions that belong to it.
============================================================================ */

const KEY_STATES = ["unknown", "working", "failing", "rate_limited", "expired", "disabled"];

function fmtMs(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

function tone(status) {
  if (status === "working" || status === "active") return "ok";
  if (status === "rate_limited" || status === "unknown" || status === "preview") return "warn";
  return "bad";
}

function Status({ value }) {
  return <span className={`st st-${value}`}>{String(value || "—").replace(/_/g, " ")}</span>;
}

function Num({ value, onChange, placeholder = "inherit", width = 110, disabled }) {
  return (
    <input
      className="mn-num"
      type="number"
      style={{ width }}
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function FilesTab() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [installed, setInstalled] = useState(true);
  const [ups, setUps] = useState([]);
  const [keys, setKeys] = useState([]);
  const [models, setModels] = useState([]);
  const [health, setHealth] = useState([]);
  const [path, setPath] = useState("providers");
  const [revealed, setRevealed] = useState({});
  const [checks, setChecks] = useState({});
  const [draft, setDraft] = useState({});

  const flash = (kind, text) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 6000);
  };

  async function load() {
    setLoading(true);
    try {
      const [u, k, m, rot, ph] = await Promise.all([
        listUpstreams(),
        listUpstreamKeys(),
        listAdminModels(),
        listKeyRotation(),
        listProviderHealth(),
      ]);
      setInstalled(Boolean(rot && ph));
      setUps(u || []);
      setModels(m || []);
      setHealth(ph || []);
      /* Fold the v6.0 rotation columns (stalls, cooldown) into the key rows so
         a key file can show its whole story in one table. */
      const byId = new Map((rot || []).map((r) => [r.id, r]));
      setKeys((k || []).map((row) => ({ ...row, ...(byId.get(row.id) || {}) })));
      setDraft({});
    } catch (e) {
      flash("bad", e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const keysOf = (id) => keys.filter((k) => k.upstream_id === id);
  const modelsOf = (id) => models.filter((m) => m.upstream_id === id);
  const healthOf = (id) => health.find((h) => h.upstream_id === id) || {};

  /* ---------------------------------------------------------------- tree */
  const nodes = useMemo(() => {
    const providerDirs = ups.map((u) => {
      const ks = keysOf(u.id);
      const ms_ = modelsOf(u.id);
      const seen = new Set();
      const keyNodes = ks.map((k) => {
        let leaf = k.label || "key";
        while (seen.has(leaf)) leaf = `${leaf}~`;
        seen.add(leaf);
        return {
          path: `providers/${u.slug}/keys/${leaf}`,
          name: leaf,
          kind: "file",
          badge: k.cooling ? "cooling" : k.status,
          tone: k.cooling ? "warn" : tone(k.status),
          meta: k.is_active ? "" : "paused",
          t: "key",
          ref: k,
        };
      });
      const modelNodes = ms_.map((m) => ({
        path: `providers/${u.slug}/models/${m.public_id}`,
        name: m.public_id,
        kind: "file",
        badge: m.timeout_ms ? fmtMs(m.timeout_ms) : "",
        tone: "",
        meta: m.is_active ? "" : "off",
        t: "model",
        ref: m,
      }));
      return {
        path: `providers/${u.slug}`,
        name: u.slug,
        kind: "dir",
        badge: u.is_active ? "" : "inactive",
        tone: u.is_active ? "" : "bad",
        meta: `${ks.length} keys · ${ms_.length} models`,
        t: "provider",
        ref: u,
        children: [
          {
            path: `providers/${u.slug}/config`,
            name: "config",
            kind: "file",
            meta: fmtMs(u.timeout_ms),
            t: "config",
            ref: u,
          },
          {
            path: `providers/${u.slug}/keys`,
            name: "keys",
            kind: "dir",
            meta: `${ks.length}`,
            t: "keys",
            ref: u,
            children: keyNodes,
          },
          {
            path: `providers/${u.slug}/models`,
            name: "models",
            kind: "dir",
            meta: `${ms_.length}`,
            t: "models",
            ref: u,
            children: modelNodes,
          },
        ],
      };
    });

    return [
      {
        path: "providers",
        name: "providers",
        kind: "dir",
        meta: `${ups.length}`,
        t: "providers",
        children: providerDirs,
      },
      {
        path: "models",
        name: "models",
        kind: "dir",
        meta: `${models.length}`,
        t: "all-models",
        children: [...models]
          .sort((a, b) => String(a.public_id).localeCompare(String(b.public_id)))
          .map((m) => ({
            path: `models/${m.public_id}`,
            name: m.public_id,
            kind: "file",
            meta: m.upstreams?.slug || "",
            badge: m.status === "active" ? "" : m.status,
            tone: tone(m.status),
            t: "model",
            ref: m,
          })),
      },
    ];
  }, [ups, keys, models]);

  const selected = useMemo(() => {
    const walk = (list) => {
      for (const n of list) {
        if (n.path === path) return n;
        if (n.children) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(nodes);
  }, [nodes, path]);

  /* -------------------------------------------------------------- actions */
  const patch = (id, key, value) =>
    setDraft((d) => ({ ...d, [id]: { ...(d[id] || {}), [key]: value } }));
  const val = (id, key, fallback) =>
    draft[id] && key in draft[id] ? draft[id][key] : (fallback ?? "");

  async function run(tag, fn, okText) {
    setBusy(tag);
    try {
      await fn();
      if (okText) flash("good", okText);
      await load();
    } catch (e) {
      flash("bad", e.message || String(e));
    } finally {
      setBusy("");
    }
  }

  async function reveal(id) {
    if (revealed[id]) {
      setRevealed((r) => ({ ...r, [id]: null }));
      return;
    }
    try {
      const secret = await revealUpstreamKey(id);
      setRevealed((r) => ({ ...r, [id]: secret }));
    } catch (e) {
      flash("bad", e.message || String(e));
    }
  }

  async function history(id) {
    if (checks[id]) {
      setChecks((c) => ({ ...c, [id]: null }));
      return;
    }
    try {
      const rows = await listKeyChecks(id, 10);
      setChecks((c) => ({ ...c, [id]: rows }));
    } catch (e) {
      flash("bad", e.message || String(e));
    }
  }

  /* --------------------------------------------------------------- tables */
  const providerCols = [
    { key: "name", label: "Provider", render: (r) => <b>{r.name}</b> },
    { key: "slug", label: "Folder", mono: true },
    { key: "base_url", label: "Base URL", mono: true, wrap: true },
    {
      key: "timeout_ms",
      label: "Wait",
      align: "right",
      render: (r) => fmtMs(r.timeout_ms),
    },
    {
      key: "keys",
      label: "Keys",
      align: "right",
      value: (r) => keysOf(r.id).length,
      render: (r) => {
        const h = healthOf(r.id);
        const all = keysOf(r.id).length;
        return h.keys_ready == null ? all : `${h.keys_ready}/${all}`;
      },
    },
    { key: "models", label: "Models", align: "right", value: (r) => modelsOf(r.id).length },
    { key: "priority", label: "Priority", align: "right" },
    {
      key: "is_active",
      label: "State",
      render: (r) => <Status value={r.is_active ? "active" : "disabled"} />,
    },
  ];

  const keyCols = [
    { key: "label", label: "Key", render: (r) => <b>{r.label}</b> },
    { key: "masked_key", label: "Secret", mono: true },
    { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
    {
      key: "cooling",
      label: "Cooldown",
      render: (r) =>
        r.cooling ? (
          <span className="st is-warn">until {relative(r.cooldown_until)}</span>
        ) : (
          "—"
        ),
    },
    { key: "timeout_count", label: "Stalls", align: "right" },
    {
      key: "success_count",
      label: "OK / fail",
      align: "right",
      render: (r) => `${num(r.success_count || 0)} / ${num(r.failure_count || 0)}`,
    },
    {
      key: "last_latency_ms",
      label: "Last",
      align: "right",
      render: (r) => (r.last_latency_ms ? ms(r.last_latency_ms) : "—"),
    },
    { key: "spend_usd", label: "Spend", align: "right", render: (r) => money(r.spend_usd || 0) },
  ];

  const modelCols = [
    { key: "public_id", label: "Model", mono: true, render: (r) => <b>{r.public_id}</b> },
    { key: "display_name", label: "Name" },
    { key: "upstream_model_id", label: "Upstream id", mono: true },
    {
      key: "timeout_ms",
      label: "Wait",
      align: "right",
      render: (r) => (r.timeout_ms ? fmtMs(r.timeout_ms) : <span className="faint">inherits</span>),
    },
    {
      key: "price_in_per_m",
      label: "In / Mtok",
      align: "right",
      render: (r) => money(r.price_in_per_m || 0),
    },
    {
      key: "price_out_per_m",
      label: "Out / Mtok",
      align: "right",
      render: (r) => money(r.price_out_per_m || 0),
    },
    { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
  ];

  /* --------------------------------------------------------------- detail */
  function Detail() {
    if (!selected) return <p className="fsx-empty">Pick a folder or file on the left.</p>;
    const t = selected.t;
    const r = selected.ref;

    if (t === "providers") {
      return (
        <FileDetail path="providers/" title="Upstream APIs" sub={`${ups.length} providers`}>
          <DataTable
            columns={providerCols}
            rows={ups}
            getKey={(x) => x.id}
            onRowClick={(x) => setPath(`providers/${x.slug}`)}
            empty="No upstream APIs yet."
            dense
            search
          />
        </FileDetail>
      );
    }

    if (t === "all-models") {
      return (
        <FileDetail path="models/" title="All models" sub={`${models.length} models`}>
          <DataTable
            columns={[
              ...modelCols.slice(0, 1),
              { key: "provider", label: "Provider", value: (x) => x.upstreams?.name || "" },
              ...modelCols.slice(1),
            ]}
            rows={models}
            getKey={(x) => x.id}
            onRowClick={(x) => setPath(`models/${x.public_id}`)}
            dense
            search
            empty="No models yet."
          />
        </FileDetail>
      );
    }

    if (t === "provider" || t === "keys" || t === "models") {
      const h = healthOf(r.id);
      const showKeys = t !== "models";
      const showModels = t !== "keys";
      return (
        <FileDetail
          path={`${selected.path}/`}
          title={r.name}
          sub={r.base_url}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setPath(`providers/${r.slug}/config`)}>
              Open config
            </Button>
          }
        >
          <KeyValues
            rows={[
              ["Wait for answer", fmtMs(r.timeout_ms)],
              ["Keys to try per request", h.key_attempts ?? "workspace default"],
              ["Rotate on stall", h.retry_on_timeout == null ? "default" : h.retry_on_timeout ? "yes" : "no"],
              ["Keys ready", h.keys_total == null ? keysOf(r.id).length : `${h.keys_ready} of ${h.keys_total}`],
              ["Requests 24h", h.requests_24h ?? "—"],
              ["Stalls 24h", h.timeouts_24h ?? "—"],
            ]}
          />
          {showKeys ? (
            <FileSection title="keys/">
              <DataTable
                columns={keyCols}
                rows={keysOf(r.id)}
                getKey={(x) => x.id}
                onRowClick={(x) => setPath(`providers/${r.slug}/keys/${x.label}`)}
                empty="No keys on this provider yet."
                dense
              />
            </FileSection>
          ) : null}
          {showModels ? (
            <FileSection title="models/">
              <DataTable
                columns={modelCols}
                rows={modelsOf(r.id)}
                getKey={(x) => x.id}
                onRowClick={(x) => setPath(`providers/${r.slug}/models/${x.public_id}`)}
                empty="No models point at this provider."
                dense
              />
            </FileSection>
          ) : null}
        </FileDetail>
      );
    }

    if (t === "config") {
      const id = `p:${r.id}`;
      const h = healthOf(r.id);
      return (
        <FileDetail path={selected.path} title={`${r.name} · config`} sub={r.base_url}>
          <KeyValues
            rows={[
              ["Slug", <code>{r.slug}</code>],
              ["Chat path", <code>{r.chat_path}</code>],
              ["Models path", <code>{r.models_path || "—"}</code>],
              ["Auth", r.auth_scheme],
              ["Priority", r.priority],
              ["State", <Status value={r.is_active ? "active" : "disabled"} />],
              ["Notes", r.notes],
            ]}
          />
          <FileSection title="How long to wait">
            <div className="mn-inline">
              <label className="mn-field">
                <span className="mn-label">Wait for answer (ms)</span>
                <Num
                  placeholder="60000"
                  value={val(id, "timeout_ms", r.timeout_ms)}
                  onChange={(v) => patch(id, "timeout_ms", v)}
                />
              </label>
              <label className="mn-field">
                <span className="mn-label">Keys to try</span>
                <Num
                  width={80}
                  disabled={!installed}
                  value={val(id, "key_attempts", r.max_key_attempts)}
                  onChange={(v) => patch(id, "key_attempts", v)}
                />
              </label>
              <label className="mn-check">
                <input
                  type="checkbox"
                  disabled={!installed}
                  checked={Boolean(
                    val(id, "retry", r.retry_on_timeout ?? h.retry_on_timeout ?? true),
                  )}
                  onChange={(e) => patch(id, "retry", e.target.checked)}
                />
                <span>A stall may try the next key</span>
              </label>
              <Button
                size="sm"
                loading={busy === id}
                onClick={() =>
                  run(
                    id,
                    () =>
                      setUpstreamTimeout(
                        r.id,
                        val(id, "timeout_ms", r.timeout_ms),
                        val(id, "key_attempts", r.max_key_attempts),
                        Boolean(val(id, "retry", r.retry_on_timeout ?? true)),
                      ),
                    "Provider deadline saved.",
                  )
                }
              >
                Save
              </Button>
            </div>
            <p className="mn-hint">
              Models of this provider inherit this wait time unless they set their own.
            </p>
          </FileSection>
        </FileDetail>
      );
    }

    if (t === "key") {
      const rows = checks[r.id];
      return (
        <FileDetail
          path={selected.path}
          title={r.label}
          sub={`${r.upstream_name || ""} · ${r.masked_key || ""}`}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => reveal(r.id)}>
                {revealed[r.id] ? "Hide" : "Reveal"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === `t:${r.id}`}
                onClick={() =>
                  run(
                    `t:${r.id}`,
                    () => updateUpstreamKey(r.id, { is_active: !r.is_active }),
                    r.is_active ? "Key paused." : "Key back in rotation.",
                  )
                }
              >
                {r.is_active ? "Pause" : "Resume"}
              </Button>
              {r.cooling ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === `c:${r.id}`}
                  onClick={() =>
                    run(`c:${r.id}`, () => clearKeyCooldown(r.id), "Cooldown cleared.")
                  }
                >
                  Clear cooldown
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => history(r.id)}>
                {rows ? "Hide checks" : "Checks"}
              </Button>
            </>
          }
        >
          {revealed[r.id] ? (
            <div className="mn-inline">
              <code className="mn-mono">{revealed[r.id]}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(revealed[r.id])}>
                Copy
              </Button>
            </div>
          ) : null}
          <KeyValues
            rows={[
              ["Status", <Status value={r.status} />],
              ["In rotation", r.is_active ? "yes" : "paused"],
              ["Weight", r.weight],
              ["Stalls recorded", r.timeout_count ?? (installed ? 0 : "—")],
              ["Last stall", r.last_timeout_at ? relative(r.last_timeout_at) : "never"],
              [
                "Cooldown",
                r.cooling ? `resting until ${relative(r.cooldown_until)}` : "not cooling",
              ],
              ["Success / failure", `${num(r.success_count || 0)} / ${num(r.failure_count || 0)}`],
              ["Failures in a row", r.consecutive_failures || 0],
              ["Last checked", r.last_checked_at ? relative(r.last_checked_at) : "never"],
              ["Last latency", r.last_latency_ms ? ms(r.last_latency_ms) : "—"],
              ["Last error", r.last_error],
              ["Spend", money(r.spend_usd || 0)],
              ["Expires", r.expires_at ? relative(r.expires_at) : "no expiry"],
            ]}
          />
          <FileSection title="Force a status">
            <div className="mn-inline">
              {KEY_STATES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={s === r.status ? "primary" : "ghost"}
                  loading={busy === `s:${r.id}:${s}`}
                  onClick={() =>
                    run(
                      `s:${r.id}:${s}`,
                      () => setUpstreamKeyStatus(r.id, s, "set from file system"),
                      `Marked ${s.replace(/_/g, " ")}.`,
                    )
                  }
                >
                  {s.replace(/_/g, " ")}
                </Button>
              ))}
            </div>
          </FileSection>
          {rows ? (
            <FileSection title="Recent checks">
              <DataTable
                columns={[
                  { key: "created_at", label: "When", render: (c) => relative(c.created_at) },
                  { key: "kind", label: "Kind" },
                  { key: "ok", label: "Result", render: (c) => (c.ok ? "ok" : "failed") },
                  { key: "status_code", label: "HTTP", align: "right" },
                  {
                    key: "latency_ms",
                    label: "Latency",
                    align: "right",
                    render: (c) => (c.latency_ms ? ms(c.latency_ms) : "—"),
                  },
                  { key: "message", label: "Message", wrap: true },
                ]}
                rows={rows}
                getKey={(c) => c.id}
                empty="No checks recorded yet."
                dense
              />
            </FileSection>
          ) : null}
        </FileDetail>
      );
    }

    if (t === "model") {
      const id = `m:${r.id}`;
      const provider = ups.find((u) => u.id === r.upstream_id);
      return (
        <FileDetail
          path={selected.path}
          title={r.public_id}
          sub={r.display_name}
          actions={
            provider ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPath(`providers/${provider.slug}/config`)}
              >
                Open provider
              </Button>
            ) : null
          }
        >
          <KeyValues
            rows={[
              ["Provider", provider?.name || r.upstreams?.name || "—"],
              ["Upstream model id", <code>{r.upstream_model_id}</code>],
              ["Status", <Status value={r.status} />],
              ["Listed", r.is_active ? "yes" : "hidden"],
              ["Context window", r.context_window ? num(r.context_window) : "—"],
              ["Max output", r.max_output_tokens ? num(r.max_output_tokens) : "—"],
              ["Price in / Mtok", money(r.price_in_per_m || 0)],
              ["Price out / Mtok", money(r.price_out_per_m || 0)],
              [
                "Wait for answer",
                r.timeout_ms
                  ? `${fmtMs(r.timeout_ms)} (own)`
                  : `${fmtMs(provider?.timeout_ms)} (from provider)`,
              ],
            ]}
          />
          <FileSection title="How long to wait">
            <div className="mn-inline">
              <label className="mn-field">
                <span className="mn-label">This model (ms)</span>
                <Num
                  disabled={!installed}
                  value={val(id, "timeout_ms", r.timeout_ms)}
                  onChange={(v) => patch(id, "timeout_ms", v)}
                />
              </label>
              <label className="mn-field">
                <span className="mn-label">Keys to try</span>
                <Num
                  width={80}
                  disabled={!installed}
                  value={val(id, "key_attempts", r.max_key_attempts)}
                  onChange={(v) => patch(id, "key_attempts", v)}
                />
              </label>
              <Button
                size="sm"
                loading={busy === id}
                disabled={!installed}
                onClick={() =>
                  run(
                    id,
                    () =>
                      setModelTimeout(
                        r.id,
                        val(id, "timeout_ms", r.timeout_ms) || null,
                        val(id, "key_attempts", r.max_key_attempts) || null,
                      ),
                    "Model deadline saved.",
                  )
                }
              >
                Save
              </Button>
            </div>
            <p className="mn-hint">Leave blank to inherit the provider&rsquo;s wait time.</p>
          </FileSection>
        </FileDetail>
      );
    }

    return <p className="fsx-empty">Nothing to show for this entry.</p>;
  }

  return (
    <div>
      <div className="mn-head">
        <div>
          <h2>File system</h2>
          <p className="mn-hint">
            Browse upstream APIs, their keys and their models as folders and files. Folders list
            their contents as tables; files show one record.
          </p>
        </div>
        <div className="mn-actions">
          <Button variant="ghost" size="sm" loading={loading} onClick={load}>
            Reload
          </Button>
        </div>
      </div>

      {!installed ? (
        <div className="mn-warn">
          Stall counts, cooldowns and per-model wait times need{" "}
          <code>{TIMEOUTS_UPGRADE_FILE}</code>. Run it in the Supabase SQL editor, then redeploy the{" "}
          <code>router</code> function.
        </div>
      ) : null}

      {msg ? <div className={msg.kind === "bad" ? "mn-bad" : "mn-good"}>{msg.text}</div> : null}

      <FileSystem
        nodes={nodes}
        selectedPath={path}
        onSelect={(n) => setPath(n.path)}
        title="gateway"
        emptyLabel="Add an upstream API to see it here."
      >
        <Detail />
      </FileSystem>
    </div>
  );
}
