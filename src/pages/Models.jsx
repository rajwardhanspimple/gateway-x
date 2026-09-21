import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner, TextInput } from "../components/ui/index.jsx";
import { listPublicModels } from "../lib/db.js";
import { isConfigured, CONFIG_MESSAGE, GATEWAY_URL } from "../lib/supabase.js";
import { compact, copy, money } from "../lib/format.js";

export default function Models() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!isConfigured) {
      setLoading(false);
      setError(CONFIG_MESSAGE);
      return;
    }
    listPublicModels()
      .then((r) => setRows(r || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((m) =>
      [m.id, m.name, m.description, ...(m.capabilities || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [rows, q]);

  return (
    <main id="main">
      <section className="section">
        <div className="container">
          <div className="adm-head" data-rv>
            <div>
              <span className="eyebrow">catalogue</span>
              <h1>Models on your gateway</h1>
              <p>
                Every id below is a public alias. Calls are resolved server-side to a
                hidden upstream model, so nothing here reveals where a request goes.
              </p>
            </div>
            <div className="adm-head-actions" style={{ minWidth: 240 }}>
              <TextInput
                placeholder="Filter by id or capability"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Filter models"
              />
            </div>
          </div>

          {error ? <Alert tone="error" title="Could not load models">{error}</Alert> : null}

          {loading ? (
            <div className="gate-wait"><Spinner size={22} /></div>
          ) : filtered.length === 0 ? (
            <div className="adm-empty">
              <b>{rows.length === 0 ? "No models published yet" : "No match"}</b>
              {rows.length === 0
                ? "An admin needs to map at least one public model id to an upstream before anything appears here."
                : "Try a different filter."}
            </div>
          ) : (
            <div className="adm-table-wrap" data-rv>
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Model id</th>
                    <th>Description</th>
                    <th className="num">Context</th>
                    <th className="num">Max out</th>
                    <th className="num">In / 1M</th>
                    <th className="num">Out / 1M</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <b className="mono">{m.id}</b>
                        {m.access_tier === "early_access" ? (
                          <span
                            className={`st st-${m.locked ? "disabled" : "working"}`}
                            style={{ marginLeft: 8 }}
                            title={
                              m.locked
                                ? "Only accounts with early access can call this model."
                                : "Early access model — enabled on your account."
                            }
                          >
                            {m.locked ? "early access · locked" : "early access"}
                          </span>
                        ) : null}
                        <div className="faint xs">{m.name}</div>
                      </td>
                      <td className="muted" style={{ maxWidth: 320 }}>
                        {m.description || "—"}
                        {m.locked ? (
                          <div className="faint xs mt-2">
                            {m.access_note || "Ask an admin to switch early access on for your account."}
                          </div>
                        ) : null}
                        {m.capabilities?.length ? (
                          <div className="faint xs mono mt-2">{m.capabilities.join(" · ")}</div>
                        ) : null}
                      </td>
                      <td className="num">{m.context_window ? compact(m.context_window) : "—"}</td>
                      <td className="num">{m.max_output_tokens ? compact(m.max_output_tokens) : "—"}</td>
                      <td className="num">{money(m.price_in_per_m)}</td>
                      <td className="num">{money(m.price_out_per_m)}</td>
                      <td><span className={`st st-${m.status === "active" ? "working" : "unknown"}`}>{m.status}</span></td>
                      <td>
                        <div className="acts">
                          <Button size="sm" variant="ghost" onClick={() => copy(m.id)}>Copy id</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="adm-card mt-5">
            <h2>Calling a model</h2>
            <p className="sub">Same request body as the OpenAI API — only the base URL and key change.</p>
            <pre className="panel mono xs" style={{ overflowX: "auto", padding: 14 }}>{`curl ${GATEWAY_URL || "<your gateway>"}/chat/completions \\
  -H "authorization: Bearer rs_live_…" \\
  -H "content-type: application/json" \\
  -d '{"model":"${
              filtered.find((m) => !m.locked)?.id || filtered[0]?.id || "your-model-id"
            }","messages":[{"role":"user","content":"hi"}]}'`}</pre>
          </div>
        </div>
      </section>
    </main>
  );
}
