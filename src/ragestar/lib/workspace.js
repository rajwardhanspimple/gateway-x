/* ==========================================================================
   workspace.js — real gateway data, shaped for the RageStar kit
   --------------------------------------------------------------------------
   The kit's screens were written against the deterministic fixtures in
   dashboard/data.js. This module fetches the same *kinds* of numbers from the
   gateway's own Supabase views and RPCs (lib/db.js) and maps them into the
   exact shapes those screens already render, so the port stayed faithful and
   still shows live data.

   Mapping contract
   ----------------
    Fields remain undefined until fetched; screens show loading/empty states,
    never demo data. Usage rows share the legacy my_usage_sheet query, with a
    date-filtered my_request_logs fallback for databases without that RPC.

   Nothing here is called unless Supabase is configured — lib/db.js talks to a
   stub that rejects, so `isConfigured` gates every call.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import { isConfigured } from "../../lib/supabase.js";
import {
  adminDashboard,
  createKey as dbCreateKey,
  dailyHealth,
  listMyKeys,
  listMyLogs,
  listPublicModels,
  myCreditLedger,
  myCredits,
  myWindowUsage,
  revokeKey as dbRevokeKey,
  routeHealth,
  setKeyExpiry as dbSetKeyExpiry,
  usageSeries,
  usageSheet,
  usageSummary,
} from "../../lib/db.js";

/* ------------------------------------------------------------------ catalog */

export const MODALITIES = ["text", "code", "vision", "image", "audio", "embedding", "rerank"];

/**
 * public_models row -> the kit's model object.
 *
 * The kit renders `{model.ttft}ms` and sorts by it, but the gateway does not
 * measure per-model TTFT, so it is null here and the two call sites print an
 * em dash rather than a zero that reads as a measurement. Everything the
 * gateway does know — context, prices, capabilities, status — is real.
 */
export function mapPublicModel(m) {
  const id = String(m.id ?? m.public_id ?? "");
  const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
  const modality = capabilities.filter((c) => MODALITIES.includes(String(c).toLowerCase()));
  const status = String(m.status ?? "").toLowerCase();

  return {
    id,
    name: m.name || m.display_name || id,
    /* "openai/gpt-4o" -> "openai"; a bare id is served by the gateway itself */
    provider: id.includes("/") ? id.split("/")[0] : "gateway",
    blurb: m.description || "",
    context: num(m.context_window),
    priceIn: num(m.price_in_per_m),
    priceOut: num(m.price_out_per_m),
    modality: modality.length ? modality : ["text"],
    ttft: null,
    throughput: null,
    license: "Proprietary",
    status: status === "beta" ? "beta" : status === "preview" ? "preview" : "ga",
    tags: capabilities.slice(0, 3).map(String),
    strengths: [],
  };
}

/**
 * The published model catalog (public_models — readable by anon, so this also
 * works on the public #/models page).
 */
export function useCatalog() {
  const [models, setModels] = useState(null);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    listPublicModels()
      .then((rows) => {
        if (live) setModels(Array.isArray(rows) ? rows.map(mapPublicModel) : []);
      })
      .catch(() => {
        /* a catalog we cannot read is not worth an error state — the kit's
           fixtures stay on screen */
        if (live) setModels(null);
      });
    return () => {
      live = false;
    };
  }, []);

  return models;
}

/** Number of published models, or null until the catalog answers. */
export function useCatalogCount() {
  const [count, setCount] = useState(null);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    listPublicModels()
      .then((rows) => {
        if (live) setCount(Array.isArray(rows) ? rows.length : 0);
      })
      .catch(() => {
        if (live) setCount(null);
      });
    return () => {
      live = false;
    };
  }, []);

  return count;
}

/* ------------------------------------------------------------------ stats */

/**
 * Public platform stats for the marketing pages: uptime over the last 90
 * days plus 24h request/token/first-token figures. Both source views are
 * world-readable, so the landing page can show them signed out. Returns null
 * until the gateway answers; callers keep their existing copy as fallback.
 */
export function useGatewayStats() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    Promise.all([dailyHealth(), routeHealth()])
      .then(([days, routes]) => {
        if (!live) return;
        const dayRows = Array.isArray(days) ? days.slice(0, 90) : [];
        const req = dayRows.reduce((a, r) => a + num(r.requests), 0);
        const failed = dayRows.reduce((a, r) => a + num(r.failed), 0);
        const uptime = req > 0 ? Math.max(0, Math.min(100, (1 - failed / req) * 100)) : null;

        const routeRows = Array.isArray(routes) ? routes : [];
        let tokens24 = 0;
        let latWeighted = 0;
        let latWeight = 0;
        let requests24 = 0;
        for (const r of routeRows) {
          const n = num(r.requests_24h ?? r.requests);
          requests24 += n;
          tokens24 += num(r.tokens_24h ?? r.tokens);
          const lat = num(r.avg_latency_ms ?? r.avg_first_token_ms);
          if (n > 0 && lat > 0) {
            latWeighted += lat * n;
            latWeight += n;
          }
        }

        setStats({
          uptime,
          requests24,
          tokens24,
          ttft: latWeight > 0 ? Math.round(latWeighted / latWeight) : null,
        });
      })
      .catch(() => {
        if (live) setStats(null);
      });
    return () => {
      live = false;
    };
  }, []);

  return stats;
}

/** The kit's chart ranges are durations; the gateway's series RPC counts days. */
export const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

/** Match the old Usage sheet instead of the dashboard's short 300-row tail. */
export const USAGE_LOG_LIMIT = 2000;
export const WORKSPACE_REFRESH_MS = 30000;

/** Share the old Usage query across the dashboard, billing and full log. */
export async function loadUsageLogs(days) {
  const sheet = await usageSheet({ days, limit: USAGE_LOG_LIMIT });
  const rows = sheet === null ? await listMyLogs(USAGE_LOG_LIMIT, days) : sheet;
  const since = Date.now() - days * 86400000;
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => new Date(row.created_at).getTime() > since)
    .map((row) => ({
      ...row,
      model_public_id: row.model_public_id ?? row.model ?? "",
      model: row.model ?? row.model_public_id ?? "",
      provider: row.provider ?? row.upstreams?.name ?? "",
      dialect: row.dialect ?? "chat",
      harness: row.harness ?? "api",
      tokens_in: num(row.tokens_in),
      tokens_out: num(row.tokens_out),
      tokens_total: num(row.tokens_in) + num(row.tokens_out),
      cost_usd: num(row.cost_usd),
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/* ------------------------------------------------------------- formatters */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function compactCount(n) {
  const v = num(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${v}`;
}

function compactTokens(n) {
  const v = num(n);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${v}`;
}

/** "3m ago" / "2h ago" / "never" — the strings the kit's rows already show. */
function ago(value) {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The activity log renders "{time} ago" itself, so hand it the bare number. */
function agoValue(value) {
  const a = ago(value);
  return a === "never" ? "—" : a.replace(" ago", "");
}

function dayLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ mappers */

/** my_api_keys row -> the kit's key row. */
function mapKey(k) {
  return {
    id: k.id,
    name: k.name || "untitled key",
    prefix: k.masked_key || `${k.key_prefix ?? ""}••••${k.key_last4 ?? ""}`,
    /* allowed_models is the closest thing to the kit's scope chips */
    scopes:
      Array.isArray(k.allowed_models) && k.allowed_models.length ? k.allowed_models : ["chat"],
    created: shortDay(k.created_at),
    lastUsed: ago(k.last_used_at),
    requests: num(k.request_count),
    env: k.environment || "live",
    status: k.status || "active",
    budget: k.monthly_budget_usd == null ? null : num(k.monthly_budget_usd),
    spend: num(k.spend_usd),
    /* api_keys.expires_at is nullable — null means the key never expires. The
       router enforces the date on every call, so the console shows both the
       date and whether it has already gone by. */
    expiresAt: k.expires_at || null,
    expires: k.expires_at ? shortDay(k.expires_at) : "never",
    expired: Boolean(k.expires_at) && new Date(k.expires_at) < new Date(),
  };
}

/** my_request_logs row -> the kit's request row. */
function mapLog(l) {
  return {
    id: l.request_id || String(l.id ?? "").slice(0, 8),
    model: l.model_public_id || "—",
    tokensIn: num(l.tokens_in),
    tokensOut: num(l.tokens_out),
    latency: num(l.latency_ms),
    status: String(l.status_code ?? (l.ok ? 200 : 500)),
    endpoint: l.policy || "/v1/chat/completions",
    region: "gateway",
    time: agoValue(l.created_at),
  };
}

/** Credit ledger rows stand in for the kit's invoices (no billing system here). */
function mapLedgerEntry(r) {
  const amount = num(r.amount_usd ?? r.delta_usd ?? r.amount);
  return {
    id: String(r.id ?? "").slice(0, 8).toUpperCase() || "—",
    date: shortDay(r.created_at),
    amount: `${amount < 0 ? "−" : ""}$${Math.abs(amount).toFixed(2)}`,
    plan: r.reason || r.note || r.kind || "credit adjustment",
    status: amount < 0 ? "debit" : "credit",
  };
}

/* -------------------------------------------------------------- derivations */

/**
 * Per-day latency for the "latency" metric. my_usage_series has no latency
 * column, so bucket the logs we already fetched and fall back to the window
 * average for days with no traffic.
 */
function latencyByDay(logs, series, fallback) {
  const buckets = new Map();
  for (const l of logs) {
    const d = new Date(l.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    const ms = num(l.latency_ms);
    if (!ms) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(ms);
    else buckets.set(key, [ms]);
  }
  return series.map((s) => {
    const key = String(s.day).slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket && bucket.length) {
      return Math.round(bucket.reduce((a, b) => a + b, 0) / bucket.length);
    }
    return Math.round(num(fallback));
  });
}

/** Spend/token breakdown per model, from the same logs. */
function usageByModelFrom(logs) {
  const totals = new Map();
  for (const l of logs) {
    /* A row with no model id is a request that never reached any model — an
       auth refusal, a routing failure, a 503 with no usable upstream keys.
       Counting those as a model named "unknown" made the mix panel invent a
       model that does not exist, and a run of failed retries crowded the
       real models out of the bar. Unrouted requests stay visible where they
       belong — the request tables and the usage log, with their error codes;
       the per-model mix is model usage only. */
    const key = String(l.model_public_id ?? "").trim();
    if (!key) continue;
    const t = totals.get(key) || { tokens: 0, cost: 0, count: 0 };
    t.tokens += num(l.tokens_in) + num(l.tokens_out);
    t.cost += num(l.cost_usd);
    t.count += 1;
    totals.set(key, t);
  }
  const total = [...totals.values()].reduce((a, b) => a + b.count, 0) || 1;
  return [...totals.entries()]
    .map(([label, t]) => ({
      label,
      share: Math.round((t.count / total) * 100),
      tokens: compactTokens(t.tokens),
      cost: num(t.cost.toFixed(2)),
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 6);
}

/** The activity feed: real requests, newest first, named by the key that made them. */
function activityFrom(logs, keys) {
  const nameById = new Map(keys.map((k) => [k.id, k.name]));
  return logs.slice(0, 6).map((l) => {
    const failed = l.ok === false || (num(l.status_code) >= 400 && num(l.status_code) > 0);
    return {
      who: nameById.get(l.api_key_id) || "API key",
      action: failed ? "request failed on" : "completed a request to",
      target: l.model_public_id || "—",
      time: agoValue(l.created_at),
      tone: failed ? "coral" : num(l.failover_count) > 0 ? "gold" : "ember",
    };
  });
}

/** Budget/limit alerts derived from the spend windows the gateway enforces. */
function alertsFrom({ summary, windows }) {
  const rows = [];
  const weeklyLimit = num(windows?.weekly_limit_usd);
  const weeklyUsed = num(windows?.weekly_used_usd);
  const fiveLimit = num(windows?.five_hour_limit_usd);
  const fiveUsed = num(windows?.five_hour_used_usd);
  const requests = num(summary?.requests);
  const failed = num(summary?.failed);
  const errRate = requests ? (failed / requests) * 100 : 0;

  if (weeklyLimit > 0) {
    const pct = (weeklyUsed / weeklyLimit) * 100;
    rows.push({
      label: "Weekly spend window",
      value: `$${weeklyUsed.toFixed(2)} / $${weeklyLimit.toFixed(2)}`,
      level: pct >= 80 ? "near limit" : "healthy",
    });
  }
  if (fiveLimit > 0) {
    const pct = (fiveUsed / fiveLimit) * 100;
    rows.push({
      label: "5-hour spend window",
      value: `$${fiveUsed.toFixed(2)} / $${fiveLimit.toFixed(2)}`,
      level: pct >= 80 ? "near limit" : "healthy",
    });
  }
  rows.push({
    label: "Failed requests",
    value: `${failed.toLocaleString()} of ${requests.toLocaleString()}`,
    level: errRate >= 5 ? "near limit" : "healthy",
  });
  return rows;
}

/** The five KPI cards the Overview renders. */
function kpisFrom({ summary, spendTotal, days }) {
  const requests = num(summary?.requests);
  const tokens = num(summary?.tokens_in) + num(summary?.tokens_out);
  const failed = num(summary?.failed);
  const errRate = requests ? (failed / requests) * 100 : 0;
  const lat = Math.round(num(summary?.avg_latency_ms));

  return [
    {
      id: "requests",
      label: "Requests",
      value: compactCount(requests),
      note: `last ${days}d · all endpoints`,
      delta: null,
    },
    {
      id: "tokens",
      label: "Tokens processed",
      value: compactTokens(tokens),
      note: "in + out combined",
      delta: null,
    },
    {
      id: "latency",
      label: "Average latency",
      value: `${lat}`,
      unit: "ms",
      note: "mean across the window",
      delta: null,
    },
    {
      id: "error",
      label: "Error rate",
      value: errRate.toFixed(2),
      unit: "%",
      note: "failed / total",
      delta: null,
    },
    {
      id: "spend",
      label: "Spend",
      value: `$${spendTotal.toFixed(0)}`,
      note: `last ${days}d`,
      delta: null,
    },
  ];
}

/* ------------------------------------------------------------------- status */

/**
 * gateway_daily_health row -> the kit's day codes (0 ok, 1 degraded, 2 outage).
 * A day with no traffic counts as ok: nothing failed, and there is no basis
 * for painting it red.
 */
function mapHealthDay(r) {
  const req = num(r.requests);
  if (!req) return 0;
  const failedRate = num(r.failed) / req;
  if (failedRate > 0.1) return 2;
  if (failedRate > 0.02) return 1;
  return 0;
}

/**
 * Public status page: 90 days of platform-wide daily health plus per-model
 * 24h health. Both views are granted to anon, so this works signed out.
 */
export function useStatus() {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    Promise.all([dailyHealth(), routeHealth()])
      .then(([days, routes]) => {
        if (!live) return;
        setData({
          days: (Array.isArray(days) ? days : []).map(mapHealthDay),
          components: (Array.isArray(routes) ? routes : []).map((m) => {
            const rate = m.success_rate == null ? null : num(m.success_rate);
            return {
              name: m.name || m.model || "—",
              note:
                m.requests_24h != null
                  ? `${num(m.requests_24h).toLocaleString()} req/24h · ${num(m.avg_latency_ms)}ms p50`
                  : "no traffic in 24h",
              status: rate != null && rate < 99 ? "degraded" : "operational",
              uptime: rate == null ? "—" : `${rate.toFixed(2)}%`,
              rate,
            };
          }),
        });
      })
      .catch(() => {
        if (live) setData(null);
      });
    return () => {
      live = false;
    };
  }, []);

  return data;
}

/**
 * Platform-wide counters for the staff panel (admin_dashboard RPC).
 *
 * Deliberately narrower than useWorkspace: the gateway has real counts for
 * accounts, upstreams, upstream keys and 24h traffic, but no org-MRR table,
 * no incident table and no audit-log table — so the kit's org / incident /
 * audit fixtures stay as sample data rather than being faked from counts.
 */
export function useStaff({ enabled = true } = {}) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(isConfigured && enabled);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!isConfigured || !enabled) {
      setLoading(false);
      return undefined;
    }
    let live = true;
    setLoading(true);
    adminDashboard()
      .then((d) => {
        if (!live) return;
        setStats(d || null);
        setError(null);
      })
      .catch((err) => {
        if (live) setError(err?.message || "Could not load platform stats");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(() => {
    if (!stats) return { live: false, loading, error, refresh };
    const requests = num(stats.requests_24h);
    const failed = num(stats.errors_24h);
    return {
      live: true,
      loading,
      error,
      refresh,
      stats,
      kpis: [
        {
          id: "traffic",
          label: "requests 24h",
          value: compactCount(requests),
          sub: `${num(stats.upstreams_active)}/${num(stats.upstreams)} upstreams active`,
          spark: true,
        },
        {
          id: "errors",
          label: "error rate",
          value: requests ? `${((failed / requests) * 100).toFixed(2)}%` : "0%",
          sub: `${failed.toLocaleString()} failed · SLO 0.5%`,
          warn: requests ? failed / requests > 0.005 : false,
        },
        {
          id: "accounts",
          label: "accounts",
          value: `${num(stats.users)}`,
          sub: `${num(stats.admins)} staff · ${num(stats.user_keys)} live api keys`,
        },
        {
          id: "upstream-keys",
          label: "failing upstream keys",
          value: `${num(stats.keys_failing)}`,
          sub: `${num(stats.keys_working)} working · ${num(stats.keys_unknown)} unknown`,
          warn: num(stats.keys_failing) > 0,
        },
      ],
    };
  }, [stats, loading, error, refresh]);
}

/* ------------------------------------------------------------------- the hook */

/**
 * Loads the signed-in account's real numbers.
 *
 * Refreshes on a timer while visible, on focus/reconnect and on demand.
 * Independent reads prevent a billing failure from freezing the request log.
 * Failed refreshes retain same-range data with an explicit error, never fixtures.
 */
export function useWorkspace(range = "30d") {
  const days = RANGE_DAYS[range] ?? 30;
  const [raw, setRaw] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(isConfigured);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      return undefined;
    }
    let live = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight || !live) return;
      inFlight = true;
      setLoading(true);
      const reads = {
        keys: listMyKeys,
        logs: () => loadUsageLogs(days),
        series: () => usageSeries(days),
        summary: () => usageSummary(days),
        credits: myCredits,
        windows: myWindowUsage,
        ledger: () => myCreditLedger(20),
      };
      const names = Object.keys(reads);
      const results = await Promise.allSettled(names.map((name) => Promise.resolve().then(reads[name])));
      if (!live) return;
      const patch = {};
      const errors = [];
      results.forEach((result, index) => {
        const name = names[index];
        if (result.status === "fulfilled") {
          patch[name] = result.value?.unavailable ? null : result.value;
          if (name === "logs") patch.logsUpdatedAt = new Date().toISOString();
        } else {
          errors.push(`${name}: ${result.reason?.message || "Could not load data"}`);
        }
      });
      setRaw((previous) => ({
        ...(previous?.days === days ? previous : {}),
        ...patch,
        days,
      }));
      setError(errors.length ? errors.join("; ") : null);
      setLoading(false);
      inFlight = false;
    };
    const loadVisible = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    void load();
    const timer = window.setInterval(loadVisible, WORKSPACE_REFRESH_MS);
    window.addEventListener("focus", loadVisible);
    window.addEventListener("online", loadVisible);
    document.addEventListener("visibilitychange", loadVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", loadVisible);
      window.removeEventListener("online", loadVisible);
      document.removeEventListener("visibilitychange", loadVisible);
    };
  }, [days, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const actions = useMemo(() => {
    if (!isConfigured) return null;
    return {
      createKey: async ({ name, environment = "live", budget = null, expiresAt = null }) => {
        const row = await dbCreateKey({ name, environment, budget, expiresAt });
        refresh();
        return row;
      },
      revokeKey: async (id) => {
        await dbRevokeKey(id);
        refresh();
      },
      setExpiry: async (id, expiresAt) => {
        await dbSetKeyExpiry(id, expiresAt);
        refresh();
      },
    };
  }, [refresh]);

  return useMemo(() => {
    if (!raw || raw.days !== days) {
      return { live: false, loading, error, refresh, actions, days };
    }

    const rawKeys = Array.isArray(raw.keys) ? raw.keys : [];
    const keys = rawKeys.map(mapKey);
    const logs = Array.isArray(raw.logs) ? raw.logs : [];
    const requests = logs.map(mapLog);
    const series = Array.isArray(raw.series) ? raw.series : [];

    const latency = latencyByDay(logs, series, raw.summary?.avg_latency_ms);
    const spendTotal = series.reduce((a, s) => a + num(s.cost_usd), 0);

    return {
      live: true,
      loading,
      error,
      refresh,
      actions,

      days,
      keys,
      requests,
      usageRows: logs,
      logsLoaded: Array.isArray(raw.logs),
      logsUpdatedAt: raw.logsUpdatedAt,
      logsLimited: logs.length >= USAGE_LOG_LIMIT,

      dataset: {
        labels: series.map((s) => dayLabel(s.day)),
        requests: series.map((s) => num(s.requests)),
        tokens: series.map((s) => num(s.tokens)),
        latency,
        spend: series.map((s) => num(s.cost_usd)),
        kpis: kpisFrom({ summary: raw.summary, spendTotal, days }),
      },

      usageByModel: usageByModelFrom(logs),
      invoices: (Array.isArray(raw.ledger) ? raw.ledger : []).map(mapLedgerEntry),
      activity: activityFrom(logs, rawKeys),
      alerts: alertsFrom({ summary: raw.summary, windows: raw.windows }),

      summary: raw.summary,
      credits: raw.credits?.unavailable ? null : raw.credits,
      windows: raw.windows,
    };
  }, [raw, loading, error, refresh, actions, days]);
}
