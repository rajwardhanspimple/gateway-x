import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui/index.jsx";
import { dailyHealth, routeHealth } from "../lib/db.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";
import { compact, ms, num, relative, shortDate } from "../lib/format.js";

function Bars({ days }) {
  const max = Math.max(1, ...days.map((d) => Number(d.requests) || 0));
  return (
    <div className="uptime-bars" style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 62 }}>
      {days.map((d) => {
        const total = Number(d.requests) || 0;
        const failed = Number(d.failed) || 0;
        const h = total === 0 ? 4 : Math.max(6, Math.round((total / max) * 62));
        const tone = total === 0 ? "var(--line)" : failed === 0 ? "#37c489" : failed / total > 0.1 ? "#e5484d" : "#e8a13a";
        return (
          <span
            key={d.day}
            title={`${shortDate(d.day)} · ${total} requests · ${failed} failed`}
            style={{ flex: 1, minWidth: 2, height: h, background: tone, borderRadius: 2, opacity: total === 0 ? 0.5 : 1 }}
          />
        );
      })}
    </div>
  );
}

export default function Status() {
  const [routes, setRoutes] = useState([]);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    Promise.all([routeHealth(), dailyHealth()])
      .then(([r, d]) => {
        setRoutes(r || []);
        setDays(d || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      setError(CONFIG_MESSAGE);
      return;
    }
    load();
  }, []);

  const totals = useMemo(() => {
    const req = routes.reduce((a, r) => a + Number(r.requests_24h || 0), 0);
    const ok = routes.reduce((a, r) => a + Number(r.ok_24h || 0), 0);
    const lat = routes.filter((r) => r.avg_latency_ms).map((r) => Number(r.avg_latency_ms));
    return {
      req,
      ok,
      rate: req ? (ok / req) * 100 : null,
      latency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      last: routes.map((r) => r.last_request_at).filter(Boolean).sort().pop() || null,
    };
  }, [routes]);

  const live = totals.req > 0;

  return (
    <main id="main">
      <section className="section">
        <div className="container">
          <div className="adm-head" data-rv>
            <div>
              <span className="eyebrow">status</span>
              <h1>Gateway status</h1>
              <p>
                Computed live from your own request logs over the last 24 hours. If
                there has been no traffic, nothing is claimed.
              </p>
            </div>
            <div className="adm-head-actions">
              <span className="status-pill">
                <span className={`dot ${live && totals.rate >= 99 ? "dot-ok dot-live" : live ? "dot-warn" : ""}`} />
                {live ? (totals.rate >= 99 ? "Operating normally" : "Degraded routes") : "No traffic in the last 24h"}
              </span>
              <Button size="sm" variant="ghost" onClick={load}>Refresh</Button>
            </div>
          </div>

          {error ? <Alert tone="error" title="Could not load status">{error}</Alert> : null}

          {loading ? (
            <div className="gate-wait"><Spinner size={22} /></div>
          ) : (
            <>
              <div className="adm-stats" data-rv>
                <div className="adm-stat"><div className="l">Requests 24h</div><div className="v">{compact(totals.req)}</div><div className="s">{num(totals.ok)} succeeded</div></div>
                <div className="adm-stat"><div className="l">Success rate</div><div className="v">{totals.rate === null ? "—" : `${totals.rate.toFixed(2)}%`}</div><div className="s">{live ? "across all routes" : "awaiting traffic"}</div></div>
                <div className="adm-stat"><div className="l">Avg latency</div><div className="v">{totals.latency ? ms(totals.latency) : "—"}</div><div className="s">successful calls only</div></div>
                <div className="adm-stat"><div className="l">Last request</div><div className="v" style={{ fontSize: 18 }}>{totals.last ? relative(totals.last) : "—"}</div><div className="s">{routes.length} published route{routes.length === 1 ? "" : "s"}</div></div>
              </div>

              <div className="adm-card mt-5" data-rv>
                <h2>Daily volume, last 90 days</h2>
                <p className="sub">Green = clean day, amber = some failures, red = above 10% failures, grey = no traffic.</p>
                {days.length ? <Bars days={days} /> : <p className="muted small">No history yet.</p>}
                <div className="row-between small mt-2">
                  <span className="faint">{days.length ? shortDate(days[0].day) : ""}</span>
                  <span className="faint">{days.length ? shortDate(days[days.length - 1].day) : ""}</span>
                </div>
              </div>

              <div className="adm-card mt-4" data-rv>
                <h2>Per-route health</h2>
                <p className="sub">Public model ids only. Upstream providers are never named on this page.</p>
                {routes.length === 0 ? (
                  <div className="adm-empty"><b>No routes published</b>Add a model mapping in the admin panel.</div>
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
                        {routes.map((r) => (
                          <tr key={r.model}>
                            <td><b className="mono">{r.model}</b><div className="faint xs">{r.name}</div></td>
                            <td className="num">{num(r.requests_24h || 0)}</td>
                            <td className="num">{r.success_rate == null ? "—" : `${Number(r.success_rate).toFixed(2)}%`}</td>
                            <td className="num">{r.avg_latency_ms ? ms(r.avg_latency_ms) : "—"}</td>
                            <td className="faint xs">{r.last_request_at ? relative(r.last_request_at) : "never"}</td>
                            <td>
                              <span className={`st st-${
                                r.requests_24h === 0 || r.requests_24h === "0"
                                  ? "unknown"
                                  : Number(r.success_rate) >= 99
                                  ? "working"
                                  : Number(r.success_rate) >= 90
                                  ? "rate_limited"
                                  : "failing"
                              }`}>
                                {r.requests_24h === 0 || r.requests_24h === "0" ? "idle" : Number(r.success_rate) >= 99 ? "healthy" : "degraded"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
