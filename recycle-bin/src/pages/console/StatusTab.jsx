/* Model status — per-route health computed from your own request logs. */

import React, { useMemo } from "react";
import { Button, Spinner } from "../../components/ui/index.jsx";
import { compact, ms, num, relative, shortDate } from "../../lib/format.js";
import { Bars, Empty, Stat, StatusChip, TabHead } from "./parts.jsx";

function routeTone(r) {
  const req = Number(r.requests_24h || 0);
  if (!req) return { chip: "unknown", label: "idle" };
  const rate = Number(r.success_rate);
  if (rate >= 99) return { chip: "working", label: "healthy" };
  if (rate >= 90) return { chip: "rate_limited", label: "degraded" };
  return { chip: "failing", label: "failing" };
}

export default function StatusTab({
  routes = [],
  days = [],
  loading = false,
  onRefresh,
}) {
  const totals = useMemo(() => {
    const req = routes.reduce((a, r) => a + Number(r.requests_24h || 0), 0);
    const ok = routes.reduce((a, r) => a + Number(r.ok_24h || 0), 0);
    const lat = routes
      .filter((r) => r.avg_latency_ms)
      .map((r) => Number(r.avg_latency_ms));
    return {
      req,
      ok,
      rate: req ? (ok / req) * 100 : null,
      latency: lat.length
        ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
        : null,
      last:
        routes
          .map((r) => r.last_request_at)
          .filter(Boolean)
          .sort()
          .pop() || null,
    };
  }, [routes]);

  const live = totals.req > 0;
  const healthy = live && totals.rate >= 99;

  return (
    <>
      <TabHead
        title="Model status"
        actions={
          <>
            <span className="status-pill">
              <span
                className={`dot ${
                  healthy ? "dot-ok dot-live" : live ? "dot-warn" : ""
                }`}
              />
              {live
                ? healthy
                  ? "Operating normally"
                  : "Degraded routes"
                : "No traffic in the last 24h"}
            </span>
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Refresh
            </Button>
          </>
        }
      >
        Computed live from request logs over the last 24 hours. If there has been
        no traffic, nothing is claimed.
      </TabHead>

      {loading ? (
        <div className="gate-wait">
          <Spinner size={22} />
          <p className="muted small mt-4">Checking route health…</p>
        </div>
      ) : (
        <>
          <div className="adm-stats">
            <Stat
              label="Requests 24h"
              value={compact(totals.req)}
              sub={`${num(totals.ok)} succeeded`}
            />
            <Stat
              label="Success rate"
              value={totals.rate === null ? "—" : `${totals.rate.toFixed(2)}%`}
              sub={live ? "across all routes" : "awaiting traffic"}
            />
            <Stat
              label="Avg latency"
              value={totals.latency ? ms(totals.latency) : "—"}
              sub="successful calls only"
            />
            <Stat
              label="Last request"
              value={totals.last ? relative(totals.last) : "—"}
              sub={`${routes.length} published route${
                routes.length === 1 ? "" : "s"
              }`}
            />
          </div>

          <div className="adm-card mt-5">
            <h3>Daily volume, last 90 days</h3>
            <p className="sub">
              Green = clean day, amber = some failures, red = above 10% failures,
              grey = no traffic.
            </p>
            {days.length ? (
              <>
                <Bars days={days} height={72} />
                <div className="row-between small mt-2">
                  <span className="faint">{shortDate(days[0].day)}</span>
                  <span className="faint">
                    {shortDate(days[days.length - 1].day)}
                  </span>
                </div>
              </>
            ) : (
              <Empty title="No history yet">
                Daily rollups appear after your first day of traffic.
              </Empty>
            )}
          </div>

          <div className="adm-card mt-4">
            <h3>Per-route health</h3>
            <p className="sub">
              Public model ids only — upstream providers are never named here.
            </p>
            {routes.length === 0 ? (
              <Empty title="No routes published">
                Add a model mapping in the admin panel to start tracking health.
              </Empty>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th className="num">Requests 24h</th>
                      <th className="num">Success</th>
                      <th className="num">Avg latency</th>
                      <th>Last call</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((r) => {
                      const tone = routeTone(r);
                      return (
                        <tr key={r.model}>
                          <td>
                            <b className="mono">{r.model}</b>
                            <div className="faint xs">{r.name}</div>
                          </td>
                          <td className="num">{num(r.requests_24h || 0)}</td>
                          <td className="num">
                            {r.success_rate == null
                              ? "—"
                              : `${Number(r.success_rate).toFixed(2)}%`}
                          </td>
                          <td className="num">
                            {r.avg_latency_ms ? ms(r.avg_latency_ms) : "—"}
                          </td>
                          <td className="faint xs">
                            {r.last_request_at
                              ? relative(r.last_request_at)
                              : "never"}
                          </td>
                          <td>
                            <span className={`st st-${tone.chip}`}>
                              {tone.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
