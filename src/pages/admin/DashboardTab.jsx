/* ==========================================================================
   Dashboard — v11.2, back to the normal admin look
   --------------------------------------------------------------------------
   v11.1 wrapped this tab in its own dark sidebar + topbar (VtShell), which
   meant the admin panel rendered TWO navigations at once: the real rail from
   Admin.jsx on the left, and a second fake one inside the content area. That
   is what looked broken. This version is a plain tab again — it renders only
   content, and lets Admin.jsx own the chrome, exactly like the other 14 tabs.

   Styling is the existing `ap-*` / `adm-*` vocabulary only. No new stylesheet,
   no chart library, no `vt-` classes, nothing appended to <body>.

   Unchanged on purpose:
     · the prop signature — Admin.jsx needs no edit
     · zero extra fetches — every figure is computed from data already loaded
     · KeyWatch stays on this tab. The watcher IS the system; only the Vaulto
       skin was removed.

   RULES OF HOOKS: every hook is in one block at the top, before any return.
   ========================================================================== */

import React, { useMemo, useState } from "react";
import KeyWatch from "../../components/KeyWatch.jsx";
import { Button } from "../../components/ui/index.jsx";
import { money, ms, num, relative } from "../../lib/format.js";
import { Bar, Empty, Kpi, LiveDot, Panel, Row } from "./parts.jsx";

const HOUR = 3600_000;
const HOUR_WINDOWS = [6, 12, 24];

function age(row) {
  const when = row?.created_at ? new Date(row.created_at).getTime() : 0;
  return when ? Date.now() - when : Number.POSITIVE_INFINITY;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index];
}

function tally(rows, pick) {
  const map = new Map();
  for (const row of rows) {
    const key = pick(row);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/* --------------------------------------------------------------------------
   Hourly columns.

   Deliberately inline-styled rather than class-based: this is the only place
   in the panel that needs a column chart, and inline styles mean the tab can
   never again reference a class that no stylesheet defines. Colours come from
   the theme tokens with literal fallbacks, so it follows light and dark.
   -------------------------------------------------------------------------- */
function HourColumns({ labels, req, fail, height = 96 }) {
  if (!req.length) return <Empty>No traffic in this window.</Empty>;

  const max = Math.max(1, ...req);

  return (
    <>
      <div
        style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}
        role="img"
        aria-label={`Requests per hour, ${labels[0]} to ${labels[labels.length - 1]}`}
      >
        {req.map((value, i) => {
          const total = value ? Math.max(3, Math.round((value / max) * height)) : 2;
          const bad = fail[i] || 0;
          const badHeight = value ? Math.min(total, Math.round((bad / value) * total)) : 0;
          return (
            <div
              key={`${labels[i]}-${i}`}
              title={`${labels[i]} · ${num(value)} requests · ${num(bad)} failed`}
              style={{
                flex: "1 1 0",
                minWidth: 4,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
              }}
            >
              {badHeight ? (
                <span
                  style={{
                    display: "block",
                    height: badHeight,
                    background: "var(--bad, #b91c1c)",
                    borderRadius: "3px 3px 0 0",
                  }}
                />
              ) : null}
              <span
                style={{
                  display: "block",
                  height: Math.max(0, total - badHeight),
                  background: value ? "var(--accent, #2563eb)" : "var(--line, #e4e4e7)",
                  opacity: value ? 1 : 0.6,
                  borderRadius: badHeight ? 0 : "3px 3px 0 0",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="ap-legend">
        <span>{labels[0]}</span>
        <span style={{ marginLeft: "auto" }}>{labels[labels.length - 1]}</span>
      </div>
    </>
  );
}

export default function DashboardTab({
  dash,
  upstreams = [],
  upKeys = [],
  models = [],
  users = [],
  logs = [],
  audit = [],
  busy = "",
  onRefresh,
  onTest,
  onAutoTest,
  onJump,
}) {
  /* =======================================================================
     HOOKS
     ======================================================================= */
  const [win, setWin] = useState(12);

  /* `logs` is the most recent rows, not the whole day — the 24h totals come
     from the dashboard view, and these percentiles are labelled "sampled"
     rather than pretending to be a daily figure. */
  const traffic = useMemo(() => {
    const failedRows = logs.filter((l) => !l.ok);
    const latencies = logs.map((l) => Number(l.latency_ms) || 0).filter((n) => n > 0);
    return {
      sample: logs.length,
      lastHour: logs.filter((l) => age(l) <= HOUR).length,
      failed: failedRows.length,
      errorRate: logs.length ? (failedRows.length / logs.length) * 100 : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      failover: logs.filter((l) => (Number(l.failover_count) || 0) > 0).length,
      topModels: tally(logs, (l) => l.model_public_id).slice(0, 6),
      errors: failedRows.slice(0, 6),
    };
  }, [logs]);

  /* Hourly buckets, oldest on the left so the shape reads like every other
     timeline in the panel. */
  const hourly = useMemo(() => {
    const now = Date.now();
    const buckets = Array.from({ length: win }, () => ({ req: 0, fail: 0 }));
    for (const l of logs) {
      const when = l.created_at ? new Date(l.created_at).getTime() : 0;
      if (!when) continue;
      const back = Math.floor((now - when) / HOUR);
      if (back < 0 || back >= win) continue;
      const slot = buckets[win - 1 - back];
      slot.req += 1;
      if (!l.ok) slot.fail += 1;
    }
    return {
      labels: buckets.map((_, i) => {
        const d = new Date(now - (win - 1 - i) * HOUR);
        return `${String(d.getHours()).padStart(2, "0")}:00`;
      }),
      req: buckets.map((b) => b.req),
      fail: buckets.map((b) => b.fail),
    };
  }, [logs, win]);

  const keyHealth = useMemo(() => {
    const bucket = { working: 0, failing: 0, expired: 0, rate_limited: 0, unknown: 0, disabled: 0 };
    for (const k of upKeys) {
      const state = String(k.status || "unknown");
      bucket[state] = (bucket[state] || 0) + 1;
    }

    const byUpstream = upstreams
      .map((u) => {
        const mine = upKeys.filter((k) => k.upstream_id === u.id);
        const working = mine.filter((k) => k.status === "working").length;
        const bad = mine.filter((k) =>
          ["failing", "expired", "rate_limited"].includes(k.status),
        ).length;
        return {
          id: u.id,
          name: u.name,
          active: u.is_active !== false,
          total: mine.length,
          working,
          bad,
          untested: Math.max(0, mine.length - working - bad),
        };
      })
      .sort((a, b) => b.bad - a.bad || b.total - a.total);

    /* A key nobody has checked in a day is not "working", it is unverified —
       that distinction is the entire point of the watch beat. */
    const active = upKeys.filter((k) => k.is_active !== false);
    const since = (k) =>
      k.last_checked_at ? Date.now() - new Date(k.last_checked_at).getTime() : Infinity;

    return {
      bucket,
      byUpstream,
      coverage: {
        hour: active.filter((k) => since(k) < HOUR).length,
        sixHours: active.filter((k) => since(k) >= HOUR && since(k) < 6 * HOUR).length,
        day: active.filter((k) => since(k) >= 6 * HOUR && since(k) < 24 * HOUR).length,
        older: active.filter((k) => since(k) >= 24 * HOUR).length,
        activeTotal: active.length,
      },
      stale: active.filter((k) => since(k) >= 24 * HOUR).length,
      lastChecked:
        upKeys
          .map((k) => k.last_checked_at)
          .filter(Boolean)
          .sort()
          .pop() || null,
    };
  }, [upKeys, upstreams]);

  /* =======================================================================
     DERIVED — no hooks past this point
     ======================================================================= */

  const badKeys =
    (keyHealth.bucket.failing || 0) +
    (keyHealth.bucket.expired || 0) +
    (keyHealth.bucket.rate_limited || 0);

  const requests24h = Number(dash?.requests_24h || 0);
  const errors24h = Number(dash?.errors_24h || 0);
  const okRate = requests24h ? ((requests24h - errors24h) / requests24h) * 100 : null;
  const errorShare = errors24h / Math.max(1, requests24h);

  const coverAge = keyHealth.lastChecked
    ? Date.now() - new Date(keyHealth.lastChecked).getTime()
    : Infinity;
  const coverState = coverAge < HOUR ? "live" : coverAge < 24 * HOUR ? "stale" : "off";

  const topModelMax = traffic.topModels.length ? traffic.topModels[0][1] : 0;

  return (
    <>
      {/* ==================================================== the figures === */}
      <div className="ap-grid">
        <Kpi
          label="Requests 24h"
          value={num(requests24h)}
          sub={okRate === null ? "no traffic yet" : `${okRate.toFixed(1)}% served`}
        />
        <Kpi
          label="Errors 24h"
          value={num(errors24h)}
          sub={`${num(traffic.lastHour)} calls in the last hour`}
          tone={errors24h === 0 ? "ok" : errorShare > 0.05 ? "bad" : "warn"}
        />
        <Kpi
          label="Spend 24h"
          value={money(dash?.cost_24h || 0)}
          sub={`${money(dash?.cost_30d || 0)} over 30 days`}
        />
        <Kpi
          label="Avg latency"
          value={ms(dash?.avg_latency_24h || traffic.p50)}
          sub={`p95 ${ms(traffic.p95)} · ${num(traffic.failover)} failed over`}
          tone={traffic.p95 > 4000 ? "warn" : undefined}
        />
        <Kpi
          label="Upstream keys"
          value={num(dash?.keys_total || upKeys.length)}
          sub={`${num(dash?.keys_working ?? keyHealth.bucket.working)} working · ${num(
            badKeys,
          )} failing · ${num(keyHealth.bucket.unknown)} untested`}
          tone={badKeys ? "bad" : "ok"}
        />
        <Kpi
          label="Accounts"
          value={num(dash?.users || users.length)}
          sub={`${num(dash?.models || models.length)} models · ${num(
            dash?.upstreams_active || 0,
          )} live upstreams`}
        />
      </div>

      {/* ================================================ the watch beat === */}
      {/* The card that decides whether the numbers above are live or a
          screenshot, so it sits directly under them. */}
      <div style={{ marginBottom: 14 }}>
        <KeyWatch onRun={onAutoTest} defaultSeconds={15} />
      </div>

      {/* ============================================== traffic + health === */}
      <div className="ap-grid ap-two">
        <Panel
          title="Requests by hour"
          sub={`${num(traffic.sample)} sampled calls · ${traffic.errorRate.toFixed(1)}% failed`}
          action={
            <div className="ap-chips" role="group" aria-label="Window">
              {HOUR_WINDOWS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="ap-chip"
                  aria-pressed={win === h}
                  onClick={() => setWin(h)}
                >
                  {h}h
                </button>
              ))}
            </div>
          }
        >
          <HourColumns labels={hourly.labels} req={hourly.req} fail={hourly.fail} />
        </Panel>

        <Panel
          title="Key health by provider"
          sub={
            keyHealth.stale
              ? `${num(keyHealth.stale)} not checked in a day`
              : "all checked recently"
          }
          action={
            <Button
              size="sm"
              variant="ghost"
              loading={busy === "test:all"}
              onClick={() => onTest?.({}, "all")}
            >
              Check every key
            </Button>
          }
        >
          <Bar
            segments={[
              { tone: "ok", value: keyHealth.bucket.working, label: "working" },
              { tone: "bad", value: badKeys, label: "failing" },
              { tone: "warn", value: keyHealth.bucket.unknown, label: "untested" },
              { tone: "idle", value: keyHealth.bucket.disabled, label: "disabled" },
            ]}
          />
          <div className="ap-legend">
            <span>
              <b>{num(keyHealth.bucket.working)}</b> working
            </span>
            <span>
              <b>{num(badKeys)}</b> failing
            </span>
            <span>
              <b>{num(keyHealth.bucket.unknown)}</b> untested
            </span>
          </div>

          {keyHealth.byUpstream.length === 0 ? (
            <Empty>No providers yet — add one to start routing.</Empty>
          ) : (
            <div className="ap-rows" style={{ marginTop: 12 }}>
              {keyHealth.byUpstream.slice(0, 6).map((u) => (
                <Row
                  key={u.id}
                  label={`${u.name}${u.active ? "" : " · paused"}`}
                  value={u.bad ? `${num(u.bad)} bad` : `${num(u.total)} keys`}
                  segments={[
                    { tone: "ok", value: u.working, label: "working" },
                    { tone: "bad", value: u.bad, label: "failing" },
                    { tone: "warn", value: u.untested, label: "untested" },
                  ]}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ============================================= failures + models === */}
      <div className="ap-grid ap-two">
        <Panel
          title="Last failures"
          sub="newest first"
          action={
            <Button size="sm" variant="ghost" onClick={() => onJump?.("logs")}>
              Open logs
            </Button>
          }
        >
          {traffic.errors.length === 0 ? (
            <Empty>Nothing has failed in the sampled window.</Empty>
          ) : (
            <div className="adm-table-wrap">
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Error</th>
                    <th className="num">HTTP</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {traffic.errors.map((l) => (
                    <tr key={l.id}>
                      <td className="mono">{l.model_public_id || "unknown model"}</td>
                      <td className="faint xs">
                        {l.error_code || "no error code"}
                        {(Number(l.failover_count) || 0) > 0
                          ? ` · ${l.failover_count} failover`
                          : ""}
                      </td>
                      <td className="num">{l.status_code ?? "—"}</td>
                      <td className="faint xs">{relative(l.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title="Busiest models"
          sub={`by sampled calls · ${num(traffic.sample)} rows`}
          action={
            <Button size="sm" variant="ghost" onClick={() => onJump?.("models")}>
              Models
            </Button>
          }
        >
          {traffic.topModels.length === 0 ? (
            <Empty>No calls in the sampled window.</Empty>
          ) : (
            <div className="ap-rows">
              {traffic.topModels.map(([id, count]) => (
                <Row
                  key={id}
                  label={id}
                  value={num(count)}
                  segments={[
                    { tone: "ok", value: count, label: "calls" },
                    { tone: "idle", value: Math.max(0, topModelMax - count), label: "" },
                  ]}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ============================================ coverage + audit === */}
      <div className="ap-grid ap-two">
        <Panel
          title="Key check coverage"
          sub={
            keyHealth.lastChecked
              ? `last pass ${relative(keyHealth.lastChecked)}`
              : "no key has ever been checked"
          }
          action={
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Reload
            </Button>
          }
        >
          <p className="ap-muted ap-xs" style={{ margin: "0 0 10px" }}>
            <LiveDot state={coverState} />
            {coverState === "live"
              ? "Keys are being verified on the beat."
              : coverState === "stale"
                ? "Checks are landing, but not in the last hour."
                : "Nothing is verifying these keys — run npm run keywatch:doctor."}
          </p>

          {keyHealth.coverage.activeTotal === 0 ? (
            <Empty>No active keys to check.</Empty>
          ) : (
            <div className="ap-rows">
              <Row
                label="Within the hour"
                value={num(keyHealth.coverage.hour)}
                segments={[
                  { tone: "ok", value: keyHealth.coverage.hour, label: "keys" },
                  {
                    tone: "idle",
                    value: keyHealth.coverage.activeTotal - keyHealth.coverage.hour,
                    label: "",
                  },
                ]}
              />
              <Row
                label="1–6 hours"
                value={num(keyHealth.coverage.sixHours)}
                segments={[
                  { tone: "ok", value: keyHealth.coverage.sixHours, label: "keys" },
                  {
                    tone: "idle",
                    value: keyHealth.coverage.activeTotal - keyHealth.coverage.sixHours,
                    label: "",
                  },
                ]}
              />
              <Row
                label="6–24 hours"
                value={num(keyHealth.coverage.day)}
                segments={[
                  { tone: "warn", value: keyHealth.coverage.day, label: "keys" },
                  {
                    tone: "idle",
                    value: keyHealth.coverage.activeTotal - keyHealth.coverage.day,
                    label: "",
                  },
                ]}
              />
              <Row
                label="Older or never"
                value={num(keyHealth.coverage.older)}
                segments={[
                  { tone: "bad", value: keyHealth.coverage.older, label: "keys" },
                  {
                    tone: "idle",
                    value: keyHealth.coverage.activeTotal - keyHealth.coverage.older,
                    label: "",
                  },
                ]}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="Recent admin activity"
          sub="written automatically"
          action={
            <Button size="sm" variant="ghost" onClick={() => onJump?.("audit")}>
              Audit trail
            </Button>
          }
        >
          {audit.length === 0 ? (
            <Empty>Admin actions appear here automatically.</Empty>
          ) : (
            <div className="ap-rows">
              {audit.slice(0, 6).map((a) => (
                <Row
                  key={a.id}
                  label={a.actor_email || "system"}
                  value={relative(a.created_at)}
                  segments={null}
                />
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
