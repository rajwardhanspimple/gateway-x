import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui/index.jsx";
import { listPublicModels } from "../lib/db.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";
import { money, num } from "../lib/format.js";

export default function Pricing() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [model, setModel] = useState("");
  const [inTokens, setInTokens] = useState(500000);
  const [outTokens, setOutTokens] = useState(150000);

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      setError(CONFIG_MESSAGE);
      return;
    }
    listPublicModels()
      .then((r) => {
        setRows(r || []);
        if (r && r.length) setModel(r[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const current = useMemo(() => rows.find((r) => r.id === model) || null, [rows, model]);
  const estimate = current
    ? (Number(current.price_in_per_m) * inTokens) / 1e6 + (Number(current.price_out_per_m) * outTokens) / 1e6
    : 0;

  return (
    <main id="main">
      <section className="section">
        <div className="container">
          <div className="adm-head" data-rv>
            <div>
              <span className="eyebrow">pricing</span>
              <h1>Your own price table</h1>
              <p>
                These numbers come straight from the price columns you set on each
                model mapping. Nothing is marked up or invented by the app.
              </p>
            </div>
            <div className="adm-head-actions">
              <Button as="a" href="#/signup" size="sm" variant="primary">Create account</Button>
              <Button as="a" href="#/docs" size="sm" variant="ghost">Read the docs</Button>
            </div>
          </div>

          {error ? <Alert tone="error" title="Could not load prices">{error}</Alert> : null}

          {loading ? (
            <div className="gate-wait"><Spinner size={22} /></div>
          ) : rows.length === 0 ? (
            <div className="adm-empty">
              <b>No prices published yet</b>
              Prices appear here as soon as an admin adds a model mapping with input
              and output rates.
            </div>
          ) : (
            <>
              <div className="adm-table-wrap" data-rv>
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="num">Input / 1M tokens</th>
                      <th className="num">Output / 1M tokens</th>
                      <th className="num">Context</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td><b className="mono">{m.id}</b><div className="faint xs">{m.name}</div></td>
                        <td className="num">{money(m.price_in_per_m)}</td>
                        <td className="num">{money(m.price_out_per_m)}</td>
                        <td className="num">{m.context_window ? num(m.context_window) : "—"}</td>
                        <td><span className={`st st-${m.status === "active" ? "working" : "unknown"}`}>{m.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="adm-card mt-5">
                <h2>Estimate a month</h2>
                <p className="sub">Uses the exact same arithmetic the gateway applies when it logs a request.</p>
                <div className="adm-grid">
                  <div>
                    <span className="adm-label">Model</span>
                    <select className="adm-select" value={model} onChange={(e) => setModel(e.target.value)}>
                      {rows.map((m) => (<option key={m.id} value={m.id}>{m.id}</option>))}
                    </select>
                  </div>
                  <div>
                    <span className="adm-label">Input tokens / month</span>
                    <input className="adm-input" type="number" min="0" step="1000" value={inTokens} onChange={(e) => setInTokens(Number(e.target.value) || 0)} />
                  </div>
                  <div>
                    <span className="adm-label">Output tokens / month</span>
                    <input className="adm-input" type="number" min="0" step="1000" value={outTokens} onChange={(e) => setOutTokens(Number(e.target.value) || 0)} />
                  </div>
                  <div>
                    <span className="adm-label">Estimated cost</span>
                    <div className="adm-stat" style={{ padding: "8px 12px" }}>
                      <div className="v" style={{ fontSize: 22, marginTop: 0 }}>{money(estimate)}</div>
                      <div className="s">per month at current rates</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="adm-card mt-4">
                <h2>What the gateway itself costs</h2>
                <p className="sub">
                  This deployment runs on your Supabase project: Postgres for keys,
                  routing and logs, plus one Edge Function for the gateway. Your only
                  running costs are Supabase and whatever the upstream API charges you.
                </p>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
