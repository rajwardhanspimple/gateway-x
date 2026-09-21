/* ==========================================================================
   Overview — v11.2, back to the normal console look
   --------------------------------------------------------------------------
   v11.1 wrapped this tab in VtShell, which drew a second sidebar and topbar
   inside the console that already has its own tab strip — two navigations on
   one screen. This version is a plain tab again: it renders content only and
   lets Console.jsx own the chrome, like the other eight tabs.

   Same props, same data, no extra fetches, no `vt-` classes. Everything below
   uses the existing `adm-*` / `con-*` vocabulary and the shared parts.

   RULES OF HOOKS: every hook is in one block at the top, before any return.
   ========================================================================== */

import React, { useMemo, useState } from "react";
import { Button } from "../../components/ui/index.jsx";
import { compact, copy, money, ms, num, relative, shortDate } from "../../lib/format.js";
import { Bars, Empty, Spark, Stat, TabHead } from "./parts.jsx";

export default function OverviewTab({
  summary,
  series = [],
  keys = [],
  logs = [],
  models = [],
  windows = null,
  gatewayUrl,
  onRefresh,
  onGo,
}) {
  /* =======================================================================
     HOOKS
     ======================================================================= */
  const [copied, setCopied] = useState(false);

  const daily = useMemo(
    () =>
      series.map((d) => ({
        day: d.day,
        requests: Number(d.requests) || 0,
        failed: Number(d.failed) || 0,
      })),
    [series],
  );

  /* =======================================================================
     DERIVED — no hooks past this point
     ======================================================================= */

  const requests = Number(summary?.requests || 0);
  const ok = Number(summary?.ok || 0);
  const failed = Number(summary?.failed || 0);
  const successRate = requests ? (ok / requests) * 100 : null;
  const tokens = Number(summary?.tokens_in || 0) + Number(summary?.tokens_out || 0);
  const activeKeys = keys.filter((k) => k.status === "active").length;
  const points = daily.map((d) => d.requests);
  const hasTraffic = points.some((v) => v > 0);

  async function copyEndpoint() {
    const done = await copy(gatewayUrl);
    setCopied(done);
    if (done) window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <>
      <TabHead
        title="Overview"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" onClick={() => onGo?.("playground")}>
              Send a test call
            </Button>
          </>
        }
      >
        Your last 30 days through the gateway. Every figure comes from your own
        request log — if there has been no traffic, nothing is claimed.
      </TabHead>

      {activeKeys === 0 ? (
        <Empty
          title="You have no active API key yet"
          action={
            <Button size="sm" variant="primary" onClick={() => onGo?.("keys")}>
              Create an API key
            </Button>
          }
        >
          The gateway will not answer without an rr_ key. Creating one takes a
          second and you can cap its spend straight away.
        </Empty>
      ) : null}

      {/* ==================================================== the figures === */}
      <div className="adm-stats">
        <Stat
          label="Requests"
          value={compact(requests)}
          sub={failed ? `${num(failed)} failed` : "no failures"}
          tone={failed ? "warn" : undefined}
        />
        <Stat
          label="Success rate"
          value={successRate === null ? "—" : `${successRate.toFixed(2)}%`}
          sub={requests ? `${num(ok)} succeeded` : "awaiting traffic"}
        />
        <Stat label="Spend" value={money(summary?.cost_usd || 0)} sub="last 30 days" />
        <Stat
          label="Avg latency"
          value={summary?.avg_latency_ms ? ms(summary.avg_latency_ms) : "—"}
          sub="successful calls only"
        />
        <Stat
          label="Tokens"
          value={compact(tokens)}
          sub={
            summary?.last_request_at
              ? `last call ${relative(summary.last_request_at)}`
              : "no calls yet"
          }
        />
      </div>

      <div className="con-split mt-5">
        {/* ------------------------------------------------------ left column */}
        <div className="con-stack">
          <div className="adm-card">
            <div className="con-card-head">
              <div>
                <h3>Requests, last 30 days</h3>
                <p className="sub">
                  Green = clean day, amber = some failures, red = above 10% failures,
                  grey = no traffic.
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onGo?.("logs")}>
                Full usage log
              </Button>
            </div>

            {hasTraffic ? (
              <>
                <div className="con-spark">
                  <Spark points={points} height={74} />
                </div>
                <Bars days={daily} height={62} />
                <div className="row-between small mt-3">
                  <span className="faint">{shortDate(daily[0]?.day)}</span>
                  <span className="faint">{shortDate(daily[daily.length - 1]?.day)}</span>
                </div>
              </>
            ) : (
              <Empty title="No traffic in this window">
                Send a request from the playground and this fills in within seconds.
              </Empty>
            )}
          </div>

          <div className="adm-card">
            <div className="con-card-head">
              <div>
                <h3>Latest requests</h3>
                <p className="sub">The most recent calls on your account.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onGo?.("logs")}>
                See all
              </Button>
            </div>

            {logs.length === 0 ? (
              <Empty title="No requests logged yet">
                Once traffic flows through the gateway it appears here within seconds.
              </Empty>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Model</th>
                      <th>Status</th>
                      <th className="num">Latency</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.slice(0, 8).map((l) => (
                      <tr key={l.id}>
                        <td className="faint xs">{relative(l.created_at)}</td>
                        <td className="mono">{l.model_public_id || "unknown"}</td>
                        <td>
                          <span className={`st st-${l.ok ? "working" : "failing"}`}>
                            {l.ok ? "ok" : "failed"}
                          </span>
                        </td>
                        <td className="num">{ms(l.latency_ms)}</td>
                        <td className="num">{num((l.tokens_in || 0) + (l.tokens_out || 0))}</td>
                        <td className="num">{money(l.cost_usd || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ----------------------------------------------------- right column */}
        <div className="con-stack">
          <div className="adm-card">
            <h3>Your endpoint</h3>
            <p className="sub">
              A drop-in replacement for the OpenAI base URL. Callers authenticate with
              your rr_ key; the upstream host, model id and key stay server-side.
            </p>
            <pre className="con-code con-endpoint">
              <code>{gatewayUrl || "set VITE_GATEWAY_URL"}</code>
            </pre>
            <div className="adm-form-actions">
              <Button size="sm" variant="ghost" disabled={!gatewayUrl} onClick={copyEndpoint}>
                {copied ? "Copied" : "Copy endpoint"}
              </Button>
              <Button as="a" href="#/docs" size="sm" variant="ghost">
                Read the docs
              </Button>
            </div>
          </div>

          <div className="adm-card">
            <h3>Spend windows</h3>
            <p className="sub">
              Rolling caps set for your account. Once a window is full, new requests
              wait until the oldest charges slide out of it. 0 means unlimited.
            </p>
            {windows?.unavailable ? (
              <Empty title="Window limits are not installed yet">
                Run supabase/upgrade-v12.5-window-limits.sql in the Supabase SQL
                editor, then reload this page.
              </Empty>
            ) : (
              <>
                <WindowMeter
                  label="Last 5 hours"
                  used={windows?.five_hour_used_usd}
                  limit={windows?.five_hour_limit_usd}
                  left={windows?.five_hour_left_usd}
                  resetAt={windows?.five_hour_reset_at}
                />
                <WindowMeter
                  label="Last 7 days"
                  used={windows?.weekly_used_usd}
                  limit={windows?.weekly_limit_usd}
                  left={windows?.weekly_left_usd}
                  resetAt={windows?.weekly_reset_at}
                />
              </>
            )}
          </div>

          <div className="adm-card">
            <h3>Quick actions</h3>
            <div className="con-quick">
              <button type="button" onClick={() => onGo?.("keys")}>
                <span>
                  <b>
                    {activeKeys || "No"} active key{activeKeys === 1 ? "" : "s"}
                  </b>
                  <small>Create, rename, cap or revoke</small>
                </span>
              </button>
              <button type="button" onClick={() => onGo?.("playground")}>
                <span>
                  <b>Send a test request</b>
                  <small>A real call through your gateway</small>
                </span>
              </button>
              <button type="button" onClick={() => onGo?.("models")}>
                <span>
                  <b>
                    {models.length} model{models.length === 1 ? "" : "s"} available
                  </b>
                  <small>Public aliases and pricing</small>
                </span>
              </button>
              <button type="button" onClick={() => onGo?.("credits")}>
                <span>
                  <b>Credits and spend</b>
                  <small>Top-ups, balance and budget caps</small>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* One row in the Spend windows card: how far into its rolling window this
   account has spent. A cap of 0 means unlimited. */
function WindowMeter({ label, used, limit, left, resetAt }) {
  const cap = Number(limit) || 0;
  const spent = Number(used) || 0;
  const over = cap > 0 && spent >= cap;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : null;
  return (
    <div className="win-row">
      <div className="row-between small">
        <b>{label}</b>
        <span style={over ? { color: "#e5484d", fontWeight: 600 } : undefined} className={over ? "" : "faint"}>
          {cap > 0 ? `${money(spent)} of ${money(cap)}` : `${money(spent)} — unlimited`}
        </span>
      </div>
      <div className="win-bar">
        <span
          style={{
            width: pct == null ? "0%" : `${pct}%`,
            background: over ? "#e5484d" : pct >= 75 ? "#e8a13a" : "#37c489",
          }}
        />
      </div>
      <div className="faint xs">
        {cap > 0
          ? over
            ? "Limit reached — new requests wait for the window to slide."
            : `${money(Number(left) || 0)} left${resetAt ? ` · headroom returns ${relative(resetAt)}` : ""}`
          : resetAt
            ? `no cap set · last charge leaves this window ${relative(resetAt)}`
            : "no cap set"}
      </div>
    </div>
  );
}
