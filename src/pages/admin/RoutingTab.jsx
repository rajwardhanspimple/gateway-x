import React, { useEffect, useMemo, useState } from "react";
import DataTable from "../../components/ui/DataTable";
import { Button } from "../../components/ui";
import {
  getSettings,
  getTimeoutSettings,
  listAdminModels,
  listProviderHealth,
  listRouteTimeouts,
  listUpstreams,
  saveTimeoutSettings,
  setModelTimeout,
  setUpstreamTimeout,
  TIMEOUTS_UPGRADE_FILE,
} from "../../lib/db";

/* ============================================================================
   Routing & deadlines
   ----------------------------------------------------------------------------
   Three questions, one screen:

     1. How long may a request wait for an answer?
        model.timeout_ms  ->  provider.timeout_ms  ->  workspace default
     2. How many different keys of that provider may one request try?
        model.max_key_attempts -> provider.max_key_attempts -> workspace default
     3. Does a stall (no answer in time) count as a reason to try the next key?
        provider.retry_on_timeout -> workspace default

   Blank means inherit, which is why the inputs are left empty rather than
   pre-filled with the inherited number — the effective value is shown in its
   own column so nothing is hidden.
============================================================================ */

const BLANK_SETTINGS = {
  default_timeout_ms: 60000,
  max_key_attempts: 3,
  retry_on_timeout: true,
  key_cooldown_seconds: 120,
  failover_enabled: true,
  max_failover_hops: 3,
};

function fmtMs(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return `${n} ms`;
  const s = n / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

function Num({ value, onChange, placeholder = "inherit", width = 92, disabled }) {
  return (
    <input
      className="mn-num"
      type="number"
      inputMode="numeric"
      style={{ width }}
      value={value ?? ""}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export default function RoutingTab() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [installed, setInstalled] = useState(true);
  const [settings, setSettings] = useState(BLANK_SETTINGS);
  const [form, setForm] = useState(BLANK_SETTINGS);
  const [providers, setProviders] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [draft, setDraft] = useState({}); // { "p:<id>" | "m:<id>": patch }

  const flash = (kind, text) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 6000);
  };

  async function load() {
    setLoading(true);
    try {
      const [cfg, health, table] = await Promise.all([
        getTimeoutSettings(),
        listProviderHealth(),
        listRouteTimeouts(),
      ]);

      if (cfg && health && table) {
        setInstalled(true);
        setSettings({ ...BLANK_SETTINGS, ...cfg });
        setForm({ ...BLANK_SETTINGS, ...cfg });
        setProviders(health);
        setRoutes(table);
      } else {
        /* upgrade-v6.0-timeouts.sql has not been run: show what the current
           schema does know, read-only, next to the install hint. */
        setInstalled(false);
        const [base, ups, models] = await Promise.all([
          getSettings(),
          listUpstreams(),
          listAdminModels(),
        ]);
        const fallbackCfg = {
          ...BLANK_SETTINGS,
          failover_enabled: base?.failover_enabled ?? true,
          max_failover_hops: base?.max_failover_hops ?? 3,
        };
        setSettings(fallbackCfg);
        setForm(fallbackCfg);
        setProviders(
          (ups || []).map((u) => ({
            upstream_id: u.id,
            provider: u.name,
            slug: u.slug,
            base_url: u.base_url,
            is_active: u.is_active,
            priority: u.priority,
            timeout_ms: u.timeout_ms,
            key_attempts: null,
            retry_on_timeout: null,
          })),
        );
        setRoutes(
          (models || []).map((m) => ({
            model_id: m.id,
            public_id: m.public_id,
            display_name: m.display_name,
            status: m.status,
            is_active: m.is_active,
            provider: m.upstreams?.name || "—",
            model_timeout_ms: m.timeout_ms ?? null,
            effective_timeout_ms:
              m.timeout_ms ??
              (ups || []).find((u) => u.id === m.upstream_id)?.timeout_ms ??
              60000,
            timeout_source: m.timeout_ms ? "model" : "provider",
          })),
        );
      }
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

  const patch = (id, key, value) =>
    setDraft((d) => ({ ...d, [id]: { ...(d[id] || {}), [key]: value } }));

  const dirty = (id) => Boolean(draft[id] && Object.keys(draft[id]).length);

  const valueFor = (id, key, row, column) =>
    draft[id] && key in draft[id] ? draft[id][key] : (row[column] ?? "");

  async function saveProvider(row) {
    const id = `p:${row.upstream_id}`;
    const d = draft[id] || {};
    setBusy(id);
    try {
      await setUpstreamTimeout(
        row.upstream_id,
        "timeout_ms" in d ? d.timeout_ms : row.timeout_ms,
        "key_attempts" in d ? d.key_attempts : row.key_attempts,
        "retry_on_timeout" in d ? d.retry_on_timeout : row.retry_on_timeout,
      );
      flash("good", `${row.provider}: deadline saved.`);
      await load();
    } catch (e) {
      flash("bad", e.message || String(e));
    } finally {
      setBusy("");
    }
  }

  async function saveRoute(row) {
    const id = `m:${row.model_id}`;
    const d = draft[id] || {};
    setBusy(id);
    try {
      await setModelTimeout(
        row.model_id,
        "timeout_ms" in d ? d.timeout_ms : row.model_timeout_ms,
        "key_attempts" in d ? d.key_attempts : row.model_key_attempts,
      );
      flash("good", `${row.public_id}: deadline saved.`);
      await load();
    } catch (e) {
      flash("bad", e.message || String(e));
    } finally {
      setBusy("");
    }
  }

  async function saveDefaults(e) {
    e.preventDefault();
    setBusy("settings");
    try {
      const out = await saveTimeoutSettings(form);
      if (!out) throw new Error(`Run ${TIMEOUTS_UPGRADE_FILE} first.`);
      flash("good", "Workspace defaults saved.");
      await load();
    } catch (err) {
      flash("bad", err.message || String(err));
    } finally {
      setBusy("");
    }
  }

  const providerCols = useMemo(
    () => [
      {
        key: "provider",
        label: "Provider",
        width: 190,
        render: (r) => (
          <span>
            <b>{r.provider}</b>
            <span className="mn-sub">{r.slug}</span>
          </span>
        ),
      },
      {
        key: "timeout_ms",
        label: "Wait for answer",
        width: 130,
        render: (r) => (
          <Num
            value={valueFor(`p:${r.upstream_id}`, "timeout_ms", r, "timeout_ms")}
            placeholder="60000"
            disabled={!installed}
            onChange={(v) => patch(`p:${r.upstream_id}`, "timeout_ms", v)}
          />
        ),
      },
      {
        key: "key_attempts",
        label: "Keys to try",
        width: 104,
        render: (r) => (
          <Num
            width={72}
            value={valueFor(`p:${r.upstream_id}`, "key_attempts", r, "key_attempts")}
            disabled={!installed}
            onChange={(v) => patch(`p:${r.upstream_id}`, "key_attempts", v)}
          />
        ),
      },
      {
        key: "retry_on_timeout",
        label: "Rotate on stall",
        width: 116,
        render: (r) => {
          const id = `p:${r.upstream_id}`;
          const on =
            draft[id] && "retry_on_timeout" in draft[id]
              ? draft[id].retry_on_timeout
              : (r.retry_on_timeout ?? settings.retry_on_timeout);
          return (
            <label className="mn-check">
              <input
                type="checkbox"
                checked={Boolean(on)}
                disabled={!installed}
                onChange={(e) => patch(id, "retry_on_timeout", e.target.checked)}
              />
              <span>{on ? "yes" : "no"}</span>
            </label>
          );
        },
      },
      {
        key: "keys_ready",
        label: "Keys ready",
        align: "right",
        width: 104,
        value: (r) => r.keys_ready ?? -1,
        render: (r) =>
          r.keys_total == null ? (
            "—"
          ) : (
            <span>
              {r.keys_ready}/{r.keys_total}
              {r.keys_cooling ? <span className="mn-warn-t"> {r.keys_cooling} cooling</span> : null}
            </span>
          ),
      },
      { key: "models", label: "Models", align: "right", width: 78 },
      { key: "requests_24h", label: "Req 24h", align: "right", width: 88 },
      {
        key: "timeouts_24h",
        label: "Stalls 24h",
        align: "right",
        width: 96,
        render: (r) =>
          r.timeouts_24h ? <span className="mn-bad-t">{r.timeouts_24h}</span> : (r.timeouts_24h ?? "—"),
      },
      {
        key: "p95_latency_ms",
        label: "p95",
        align: "right",
        width: 88,
        render: (r) => fmtMs(r.p95_latency_ms),
      },
      {
        key: "save",
        label: "",
        sortable: false,
        width: 78,
        render: (r) =>
          dirty(`p:${r.upstream_id}`) ? (
            <Button
              size="sm"
              loading={busy === `p:${r.upstream_id}`}
              onClick={() => saveProvider(r)}
            >
              Save
            </Button>
          ) : null,
      },
    ],
    [draft, busy, installed, settings.retry_on_timeout],
  );

  const routeCols = useMemo(
    () => [
      {
        key: "public_id",
        label: "Model",
        width: 230,
        render: (r) => (
          <span>
            <b className="is-mono">{r.public_id}</b>
            <span className="mn-sub">{r.display_name}</span>
          </span>
        ),
      },
      { key: "provider", label: "Provider", width: 140 },
      {
        key: "model_timeout_ms",
        label: "Model wait",
        width: 120,
        render: (r) => (
          <Num
            value={valueFor(`m:${r.model_id}`, "timeout_ms", r, "model_timeout_ms")}
            disabled={!installed}
            onChange={(v) => patch(`m:${r.model_id}`, "timeout_ms", v)}
          />
        ),
      },
      {
        key: "effective_timeout_ms",
        label: "In force",
        align: "right",
        width: 96,
        render: (r) => fmtMs(r.effective_timeout_ms),
      },
      {
        key: "timeout_source",
        label: "From",
        width: 92,
        render: (r) => <span className="st is-info">{r.timeout_source}</span>,
      },
      {
        key: "model_key_attempts",
        label: "Keys to try",
        width: 104,
        render: (r) => (
          <Num
            width={72}
            value={valueFor(`m:${r.model_id}`, "key_attempts", r, "model_key_attempts")}
            disabled={!installed}
            onChange={(v) => patch(`m:${r.model_id}`, "key_attempts", v)}
          />
        ),
      },
      {
        key: "effective_key_attempts",
        label: "In force",
        align: "right",
        width: 84,
        render: (r) => r.effective_key_attempts ?? "—",
      },
      {
        key: "keys_ready",
        label: "Keys",
        align: "right",
        width: 80,
        render: (r) => (r.keys_total == null ? "—" : `${r.keys_ready}/${r.keys_total}`),
      },
      { key: "requests_24h", label: "Req 24h", align: "right", width: 88 },
      {
        key: "timeouts_24h",
        label: "Stalls 24h",
        align: "right",
        width: 96,
        render: (r) =>
          r.timeouts_24h ? <span className="mn-bad-t">{r.timeouts_24h}</span> : (r.timeouts_24h ?? "—"),
      },
      {
        key: "p95_latency_ms",
        label: "p95",
        align: "right",
        width: 84,
        render: (r) => fmtMs(r.p95_latency_ms),
      },
      {
        key: "save",
        label: "",
        sortable: false,
        width: 78,
        render: (r) =>
          dirty(`m:${r.model_id}`) ? (
            <Button size="sm" loading={busy === `m:${r.model_id}`} onClick={() => saveRoute(r)}>
              Save
            </Button>
          ) : null,
      },
    ],
    [draft, busy, installed],
  );

  const stalls = routes.reduce((n, r) => n + (r.timeouts_24h || 0), 0);
  const cooling = providers.reduce((n, p) => n + (p.keys_cooling || 0), 0);

  return (
    <div>
      <div className="mn-head">
        <div>
          <h2>Routing &amp; deadlines</h2>
          <p className="mn-hint">
            A model uses its own wait time if it has one, otherwise its provider&rsquo;s, otherwise
            the workspace default. When a key does not answer in time the gateway moves to the next
            key of that same provider.
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
          Read-only: run <code>{TIMEOUTS_UPGRADE_FILE}</code> in the Supabase SQL editor, then
          redeploy the <code>router</code> function. Until then the tables below show the current
          schema and editing is disabled.
        </div>
      ) : null}

      {msg ? <div className={msg.kind === "bad" ? "mn-bad" : "mn-good"}>{msg.text}</div> : null}

      <div className="mn-stats">
        <div className="mn-stat">
          <span className="l">Default wait</span>
          <span className="v">{fmtMs(settings.default_timeout_ms)}</span>
          <span className="s">used when nothing else is set</span>
        </div>
        <div className="mn-stat">
          <span className="l">Keys per request</span>
          <span className="v">{settings.max_key_attempts}</span>
          <span className="s">before the provider is given up on</span>
        </div>
        <div className="mn-stat">
          <span className="l">Stalls (24h)</span>
          <span className="v">{stalls}</span>
          <span className="s">requests that ran out of time</span>
        </div>
        <div className="mn-stat">
          <span className="l">Keys cooling</span>
          <span className="v">{cooling}</span>
          <span className="s">rested for {settings.key_cooldown_seconds}s after a stall</span>
        </div>
      </div>

      <form className="mn-card" onSubmit={saveDefaults}>
        <h3>Workspace defaults</h3>
        <div className="mn-grid">
          <label className="mn-field">
            <span className="mn-label">Wait for answer (ms)</span>
            <input
              type="number"
              min={1000}
              max={600000}
              value={form.default_timeout_ms}
              onChange={(e) => setForm({ ...form, default_timeout_ms: e.target.value })}
            />
          </label>
          <label className="mn-field">
            <span className="mn-label">Keys to try per request</span>
            <input
              type="number"
              min={1}
              max={10}
              value={form.max_key_attempts}
              onChange={(e) => setForm({ ...form, max_key_attempts: e.target.value })}
            />
          </label>
          <label className="mn-field">
            <span className="mn-label">Rest a stalled key for (s)</span>
            <input
              type="number"
              min={0}
              max={3600}
              value={form.key_cooldown_seconds}
              onChange={(e) => setForm({ ...form, key_cooldown_seconds: e.target.value })}
            />
          </label>
          <label className="mn-field">
            <span className="mn-label">Providers per request</span>
            <input
              type="number"
              min={1}
              max={10}
              value={form.max_failover_hops}
              onChange={(e) => setForm({ ...form, max_failover_hops: e.target.value })}
            />
          </label>
        </div>
        <div className="mn-row">
          <label className="mn-check">
            <input
              type="checkbox"
              checked={Boolean(form.retry_on_timeout)}
              onChange={(e) => setForm({ ...form, retry_on_timeout: e.target.checked })}
            />
            <span>A stall may try the next key</span>
          </label>
          <label className="mn-check">
            <input
              type="checkbox"
              checked={Boolean(form.failover_enabled)}
              onChange={(e) => setForm({ ...form, failover_enabled: e.target.checked })}
            />
            <span>Fall back to another provider</span>
          </label>
          <span className="mn-right">
            <Button type="submit" size="sm" loading={busy === "settings"} disabled={!installed}>
              Save defaults
            </Button>
          </span>
        </div>
      </form>

      <div className="mn-card">
        <h3>Per provider</h3>
        <p className="mn-hint">
          The wait time every model of this provider inherits, how many of its keys one request may
          use, and whether a stall counts as a reason to rotate.
        </p>
        <DataTable
          columns={providerCols}
          rows={providers}
          getKey={(r) => r.upstream_id}
          empty="No upstream APIs yet. Add one on the Upstreams tab."
          dense
        />
      </div>

      <div className="mn-card">
        <h3>Per model</h3>
        <p className="mn-hint">
          Leave &ldquo;Model wait&rdquo; blank to inherit the provider. &ldquo;In force&rdquo; is
          what the gateway will actually use.
        </p>
        <DataTable
          columns={routeCols}
          rows={routes}
          getKey={(r) => r.model_id}
          search
          searchPlaceholder="Filter models…"
          empty="No models yet. Add or import them on the Models tab."
          dense
          maxHeight={620}
        />
      </div>
    </div>
  );
}
