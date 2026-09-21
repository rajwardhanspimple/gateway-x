/* ==========================================================================
   Playground — sends a real request through your own gateway.
   --------------------------------------------------------------------------
   The old version was a single column: key, model, prompt, button, and then
   the answer appended underneath the form. Two problems with that. The reply
   pushed the controls around every time it arrived, and while a request was
   in flight the panel showed nothing at all — so a slow upstream looked like
   a broken one.

   It is now a request / response pair. The composer keeps its place on the
   left, the response panel owns the right and stays put while you scroll. It
   reports its own state at every step (idle → sending, with a live timer →
   answered), puts the gateway's headers in a ruled read-out instead of a row
   of loose pills, and keeps the last few runs of the session so you can flip
   between two models without re-sending.

   The gateway contract is unchanged: onRun({ apiKey, model, prompt }).
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Field, TextInput } from "../../components/ui/index.jsx";
import { compact, copy, money, ms } from "../../lib/format.js";
import { useElapsed, useTypewriter } from "../../lib/motion.js";
import { Empty, TabHead } from "./parts.jsx";

/* Starting points, so the first request is one click rather than one essay.
   Each one exercises something different about the route. */
const PRESETS = [
  {
    id: "ping",
    label: "route check",
    text: "Reply with one short sentence confirming the route works.",
  },
  {
    id: "json",
    label: "json only",
    text: 'Return only this JSON object and nothing else: {"ok": true, "model": "<the model id you are\u000a  serving as>"}',
  },
  {
    id: "long",
    label: "long answer",
    text: "Explain what an LLM gateway does, and why a reseller needs failover between upstreams. Four short paragraphs.",
  },
  {
    id: "count",
    label: "count to 20",
    text: "Count from 1 to 20, comma separated. No other text.",
  },
];

let runSeq = 0;

function Cell({ label, value }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="pg-meta-cell">
      <span className="l">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

export default function PlaygroundTab({
  models = [],
  gatewayUrl,
  presetKey = "",
  onRun,
}) {
  const [apiKey, setApiKey] = useState(presetKey);
  const [model, setModel] = useState(models[0]?.id || "");
  const [prompt, setPrompt] = useState(PRESETS[0].text);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState([]);
  const [copied, setCopied] = useState("");

  /* live timer while the request is out, so a slow upstream still reads as
     "working" rather than "hung" */
  const elapsed = useElapsed(busy);

  /* the answer arrives a few hundred characters a second — same feel as a
     streamed response, without pretending the transport streams */
  const answer = result?.ok ? result.content || "(empty response)" : "";
  const [shown, done] = useTypewriter(answer, { enabled: Boolean(result?.fresh) });

  useEffect(() => {
    if (presetKey) setApiKey(presetKey);
  }, [presetKey]);

  useEffect(() => {
    if (!model && models.length) setModel(models[0].id);
  }, [models, model]);

  useEffect(() => {
    if (!copied) return undefined;
    const id = window.setTimeout(() => setCopied(""), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  const picked = useMemo(
    () => models.find((m) => m.id === model) || null,
    [models, model]
  );

  const curl = useMemo(() => {
    const base = gatewayUrl || "https://your-gateway";
    const body = JSON.stringify({
      model: model || "model-id",
      messages: [{ role: "user", content: prompt }],
    });
    return [
      `curl ${base}/chat/completions \\`,
      `  -H "authorization: Bearer ${apiKey || "rs_live_\u2026"}" \\`,
      '  -H "content-type: application/json" \\',
      `  -d '${body.replace(/'/g, "'\\''")}'`,
    ].join("\n");
  }, [gatewayUrl, model, prompt, apiKey]);

  const send = useCallback(async () => {
    if (!apiKey || !model || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const next = await onRun({ apiKey, model, prompt });
      /* `fresh` only marks the run that just came back, so replaying an older
         run from the history list does not re-type it */
      const stamped = { ...next, fresh: true, model, id: ++runSeq };
      setResult(stamped);
      setRuns((prev) => [stamped, ...prev].slice(0, 6));
    } finally {
      setBusy(false);
    }
  }, [apiKey, model, prompt, busy, onRun]);

  const submit = (e) => {
    e.preventDefault();
    send();
  };

  /* ⌘/Ctrl + Enter sends from inside the prompt box */
  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  const head = result?.headers || {};

  return (
    <>
      <TabHead
        title="Playground"
        actions={
          runs.length ? (
            <span className="pg-hint">
              {runs.length} run{runs.length === 1 ? "" : "s"} this session
            </span>
          ) : null
        }
      >
        Sends a real request through your gateway with one of your keys. The
        response never names the upstream provider.
      </TabHead>

      {models.length === 0 ? (
        <div className="adm-card">
          <Empty title="No models published yet">
            An admin needs to map at least one public model id to an upstream.
          </Empty>
        </div>
      ) : (
        <div className="pg">
          {/* ------------------------------------------------- composer */}
          <form className="adm-card pg-card" onSubmit={submit} onKeyDown={onKeyDown}>
            <div className="pg-head">
              <b>Request</b>
              <div className="pg-head-right">
                <span className="pg-chip">post /chat/completions</span>
              </div>
            </div>

            <div className="pg-body">
              <div className="pg-row">
                <Field
                  label="Gateway key"
                  htmlFor="pg-key"
                  hint="rs_live_… or rs_test_…"
                >
                  <TextInput
                    id="pg-key"
                    placeholder="rs_live_…"
                    value={apiKey}
                    autoComplete="off"
                    spellCheck="false"
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </Field>
                <div>
                  <label className="adm-label" htmlFor="pg-model">
                    Model
                  </label>
                  <select
                    id="pg-model"
                    className="adm-select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                  {picked ? (
                    <div className="pg-metas">
                      {picked.context_window ? (
                        <span className="pg-chip">
                          context <b>{compact(picked.context_window)}</b>
                        </span>
                      ) : null}
                      {picked.price_in_per_m ? (
                        <span className="pg-chip">
                          in <b>{money(picked.price_in_per_m)}/M</b>
                        </span>
                      ) : null}
                      {picked.price_out_per_m ? (
                        <span className="pg-chip">
                          out <b>{money(picked.price_out_per_m)}/M</b>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="pg-prompt">
                <div className="pg-field-top">
                  <label className="adm-label" htmlFor="pg-prompt">
                    Prompt
                  </label>
                  <span className="pg-hint">{prompt.length} chars</span>
                </div>
                <textarea
                  id="pg-prompt"
                  className="adm-textarea pg-textarea"
                  value={prompt}
                  spellCheck="false"
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="pg-presets">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`pg-preset ${prompt === p.text ? "is-on" : ""}`}
                      onClick={() => setPrompt(p.text)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pg-actions">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={busy}
                disabled={!apiKey || !model}
              >
                Send request
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (await copy(curl)) setCopied("curl");
                }}
              >
                {copied === "curl" ? "Copied" : "Copy cURL"}
              </Button>
              <span className="pg-kbd">⌘ ↵</span>
              <span className="pg-spacer" />
              <span className="pg-endpoint">
                {gatewayUrl || "(gateway not configured)"}
              </span>
            </div>
          </form>

          {/* ------------------------------------------------- response */}
          <aside className="adm-card pg-card pg-result">
            <div className="pg-head">
              <b>Response</b>
              <div className="pg-head-right">
                {busy ? (
                  <span className="pg-status">
                    <i className="pg-led m-pulse" aria-hidden="true" />
                    sending {ms(elapsed)}
                  </span>
                ) : result ? (
                  <span
                    className={`pg-status ${result.ok ? "is-ok" : "is-err"}`}
                  >
                    <i className="pg-led" aria-hidden="true" />
                    {result.status ? `http ${result.status}` : "no response"}
                  </span>
                ) : (
                  <span className="pg-status">idle</span>
                )}
              </div>
            </div>

            {result && !busy ? (
              <div className="pg-meta-grid">
                <Cell label="latency" value={ms(result.elapsed)} />
                <Cell label="model" value={head.model || result.model} />
                <Cell label="failover" value={head.failover} />
                <Cell
                  label="cost"
                  value={head.cost ? money(head.cost, 4) : null}
                />
                <Cell
                  label="credits left"
                  value={head.credits ? money(head.credits) : null}
                />
                <Cell label="request" value={head.requestId} />
              </div>
            ) : null}

            {busy ? (
              <div className="pg-wait" aria-live="polite">
                <span className="m-skel" style={{ width: "92%" }} />
                <span className="m-skel" style={{ width: "78%" }} />
                <span className="m-skel" style={{ width: "86%" }} />
                <span className="m-skel" style={{ width: "44%" }} />
              </div>
            ) : !result ? (
              <div className="pg-idle">
                <b>Nothing sent yet</b>
                <span>
                  Paste a gateway key, pick a model, then send. The reply, its
                  latency and the route it took land here.
                </span>
              </div>
            ) : result.ok ? (
              <div className="pg-out" aria-live="polite">
                {shown}
                {done ? null : <i className="m-caret" aria-hidden="true" />}
              </div>
            ) : (
              <div className="pg-out is-err" role="alert">
                {result.error || "The gateway did not return a response."}
              </div>
            )}

            {result && !busy ? (
              <div className="pg-foot">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const text = result.ok
                      ? result.content || ""
                      : result.error || "";
                    if (await copy(text)) setCopied("out");
                  }}
                >
                  {copied === "out" ? "Copied" : "Copy response"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                  Clear
                </Button>
              </div>
            ) : null}

            {runs.length > 1 ? (
              <>
                <div className="pg-head pg-head-sub">
                  <b>This session</b>
                </div>
                <ul className="pg-hist">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className={`pg-hist-row ${r.ok ? "" : "is-err"}`}
                        onClick={() => setResult({ ...r, fresh: false })}
                      >
                        <i className="pg-led" aria-hidden="true" />
                        <span className="pg-hist-model">{r.model}</span>
                        <span className="pg-hist-ms">{ms(r.elapsed)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </>
  );
}
