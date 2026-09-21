import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../../components/ui/index.jsx";
import { relative } from "../../lib/format.js";
import {
  listKieProviders,
  saveKieProvider,
  listKieKeys,
  addKieKey,
  updateKieKey,
  deleteKieKey,
  revealKieKey,
  testKie,
  probeKie,
} from "../../lib/db.js";

/* ============================================================================
   KIE ORIGINAL  —  api.kie.ai codex /responses
   ----------------------------------------------------------------------------
   Kie accepts exactly ONE request shape, so the panel only ever composes that
   one:

     POST https://api.kie.ai/codex/v1/responses
     Authorization: Bearer <key>
     Content-Type: application/json

     { "model": "gpt-6-astra",
       "stream": true,
       "input": "…"  |  [{ "role": "user", "content": [
                          { "type": "input_text",  "text": "…" },
                          { "type": "input_image", "image_url": "https://…" }]}],
       "tools":     [{ "type": "web_search" }],   // optional
       "reasoning": { "effort": "high" } }        // optional

   No messages[], no max_tokens, no second vendor shape: the old Anthropic
   sub-tab is gone and the edge function refuses those fields outright.
   Keys live in kie_provider_keys, listed masked, revealed only through an
   audited RPC. Test / Probe stream through the `kie` edge function so the
   browser never sees the secret.
============================================================================ */

const CATEGORY = "codex";
const CANON_ENDPOINT = "https://api.kie.ai/codex/v1/responses";
const DEFAULT_MODEL = "gpt-6-astra";
const DOC_IMAGE =
  "https://file.aiquickdraw.com/custom-page/akr/section-images/1759055072437dqlsclj2.png";

const EMPTY = {
  label: "",
  endpoint: CANON_ENDPOINT,
  default_model: DEFAULT_MODEL,
  models: "",
  is_active: false,
  notes: "",
};

function toForm(p) {
  if (!p) return { ...EMPTY };
  return {
    label: p.label || "",
    endpoint: p.endpoint || CANON_ENDPOINT,
    default_model: p.default_model || DEFAULT_MODEL,
    models: Array.isArray(p.models) ? p.models.join(", ") : p.models || "",
    is_active: !!p.is_active,
    notes: p.notes || "",
  };
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* Mirror of the payload the edge function will build, for the preview box. */
function previewPayload({ model, prompt, imageUrl, webSearch, effort }) {
  const text = (prompt || "").trim() || "Say hello in one word.";
  const img = (imageUrl || "").trim();
  const payload = {
    model: (model || "").trim() || DEFAULT_MODEL,
    stream: true,
    input: img
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text },
              { type: "input_image", image_url: img },
            ],
          },
        ]
      : text,
  };
  if (webSearch) payload.tools = [{ type: "web_search" }];
  if (effort) payload.reasoning = { effort };
  return payload;
}

export default function KieTab() {
  const [providers, setProviders] = useState([]);
  const [keys, setKeys] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [newKey, setNewKey] = useState({ label: "", api_key: "" });
  const [test, setTest] = useState({
    model: "",
    prompt: "",
    imageUrl: "",
    webSearch: false,
    effort: "",
    running: "",
    out: null,
    probe: null,
    err: "",
  });

  const flash = (kind, text) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 6000);
  };

  const provider = useMemo(
    () => providers.find((p) => p.category === CATEGORY) || null,
    [providers],
  );
  const catKeys = useMemo(() => keys.filter((k) => k.category === CATEGORY), [keys]);
  const request = useMemo(
    () =>
      previewPayload({
        model: test.model || form.default_model,
        prompt: test.prompt,
        imageUrl: test.imageUrl,
        webSearch: test.webSearch,
        effort: test.effort,
      }),
    [test.model, test.prompt, test.imageUrl, test.webSearch, test.effort, form.default_model],
  );

  async function load() {
    setLoading(true);
    try {
      const [ps, ks] = await Promise.all([listKieProviders(), listKieKeys()]);
      setProviders(ps);
      setKeys(ks);
    } catch (e) {
      flash("bad", e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setForm(toForm(providers.find((p) => p.category === CATEGORY)));
    setRevealed({});
  }, [providers]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setT = (k, v) => setTest((t) => ({ ...t, [k]: v }));

  async function onSaveProvider(e) {
    e.preventDefault();
    setBusy("provider");
    try {
      await saveKieProvider(CATEGORY, {
        label: form.label,
        /* the endpoint is pinned by the edge function; saved for visibility */
        endpoint: CANON_ENDPOINT,
        stream: true,
        content_type: "text/event-stream",
        delta_event_type: "response.output_text.delta",
        default_model: form.default_model,
        models: form.models,
        is_active: form.is_active,
        notes: form.notes,
      });
      flash("good", "Kie codex saved.");
      await load();
    } catch (err) {
      flash("bad", err.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function onAddKey(e) {
    e.preventDefault();
    if (!provider) {
      flash("bad", "Run the v11.5 SQL upgrade first — the codex row is not seeded yet.");
      return;
    }
    setBusy("addkey");
    try {
      await addKieKey({
        kie_provider_id: provider.id,
        label: newKey.label,
        api_key: newKey.api_key,
      });
      setNewKey({ label: "", api_key: "" });
      flash("good", "Key added.");
      await load();
    } catch (err) {
      flash("bad", err.message || String(err));
    } finally {
      setBusy("");
    }
  }

  async function onReveal(id) {
    try {
      const value = await revealKieKey(id);
      setRevealed((r) => ({ ...r, [id]: value }));
    } catch (e) {
      flash("bad", e.message || String(e));
    }
  }

  async function onToggleKey(k) {
    try {
      await updateKieKey(k.id, { is_active: !k.is_active });
      await load();
    } catch (e) {
      flash("bad", e.message || String(e));
    }
  }

  async function onRemoveKey(id) {
    try {
      await deleteKieKey(id);
      setRevealed((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      await load();
    } catch (e) {
      flash("bad", e.message || String(e));
    }
  }

  async function onTest(e) {
    e.preventDefault();
    setTest((t) => ({ ...t, running: "test", out: null, probe: null, err: "" }));
    try {
      const res = await testKie({
        model: test.model,
        prompt: test.prompt,
        image_url: test.imageUrl,
        web_search: test.webSearch,
        reasoning_effort: test.effort,
      });
      setTest((t) => ({ ...t, running: "", out: res }));
      await load(); // the call stamps the key's status
    } catch (err) {
      setTest((t) => ({ ...t, running: "", err: err.message || String(err) }));
    }
  }

  async function onProbe() {
    setTest((t) => ({ ...t, running: "probe", out: null, probe: null, err: "" }));
    try {
      const res = await probeKie({ model: test.model });
      setTest((t) => ({ ...t, running: "", probe: res }));
      await load();
    } catch (err) {
      setTest((t) => ({ ...t, running: "", err: err.message || String(err) }));
    }
  }

  if (loading) {
    return (
      <div className="ap-panel">
        <div className="ap-empty">
          <Spinner /> Loading Kie configuration…
        </div>
      </div>
    );
  }

  return (
    <div className="kie">
      {msg ? (
        <div style={{ marginBottom: 12 }}>
          <Alert tone={msg.kind === "good" ? "success" : "error"}>{msg.text}</Alert>
        </div>
      ) : null}

      <p className="kie-blurb">
        One shape only: <code>POST /codex/v1/responses</code> with{" "}
        <code>{'{ model, stream: true, input, tools?, reasoning? }'}</code>. The gateway
        refuses <code>messages</code>, <code>max_tokens</code> and any extra header, because
        Kie rejects them.
      </p>

      {!provider ? (
        <Alert tone="error" title="Not seeded yet">
          The <code>codex</code> row is missing. Run{" "}
          <code>supabase/upgrade-v11.5-kie-codex-responses.sql</code> in the SQL editor, then
          reload.
        </Alert>
      ) : null}

      {/* ---------------------------------------------------------- endpoint */}
      <form className="ap-panel" onSubmit={onSaveProvider}>
        <header>
          <h3>Endpoint & model</h3>
          <span className="ap-sub">The streaming contract is fixed; only the models are yours</span>
        </header>

        <div className="kie-grid">
          <label className="kie-field">
            <span>Display label</span>
            <input
              type="text"
              value={form.label}
              onChange={(e) => set("label", e.target.value)}
              placeholder="Kie · Codex Responses"
            />
          </label>

          <label className="kie-field">
            <span>Default model</span>
            <input
              type="text"
              value={form.default_model}
              onChange={(e) => set("default_model", e.target.value)}
              placeholder={DEFAULT_MODEL}
            />
          </label>

          <label className="kie-field kie-wide kie-mono">
            <span>Endpoint (pinned)</span>
            <input type="text" value={CANON_ENDPOINT} readOnly disabled />
          </label>

          <div className="kie-field kie-mono">
            <span>Streaming contract</span>
            <div className="kie-locknote">
              <code>"stream": true</code> · <code>text/event-stream</code> ·{" "}
              <code>response.output_text.delta</code> · ends on <code>[DONE]</code>
            </div>
          </div>

          <label className="kie-field kie-wide kie-mono">
            <span>Models (comma or newline separated)</span>
            <textarea
              value={form.models}
              onChange={(e) => set("models", e.target.value)}
              placeholder={DEFAULT_MODEL}
            />
          </label>

          <label className="kie-field kie-check">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set("is_active", e.target.checked)}
            />
            <span>Active (let the gateway route to Kie codex)</span>
          </label>

          <label className="kie-field kie-wide">
            <span>Notes</span>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Anything the next admin should know"
            />
          </label>
        </div>

        <div className="kie-actions">
          <Button type="submit" loading={busy === "provider"} disabled={!provider}>
            Save Kie codex
          </Button>
        </div>
      </form>

      {/* -------------------------------------------------------------- keys */}
      <section className="ap-panel">
        <header>
          <h3>API keys</h3>
          <span className="ap-sub">Stored secret · shown masked · used by the kie edge function</span>
        </header>

        {catKeys.length === 0 ? (
          <div className="kie-key-empty">No keys yet.</div>
        ) : (
          <ul className="kie-keys">
            {catKeys.map((k) => (
              <li key={k.id} className="kie-key">
                <div className="kie-key-main">
                  <span className="kie-key-val">{revealed[k.id] || k.masked_key}</span>
                  <span className="kie-key-sub">
                    {k.label} · {k.key_length} chars · added {relative(k.created_at)}
                    {k.last_error ? ` · ${k.last_error}` : ""}
                  </span>
                </div>
                <span className={`kie-st kie-st-${k.status || "unknown"}`}>
                  {String(k.status || "unknown").replace(/_/g, " ")}
                </span>
                <div className="kie-key-actions">
                  <button
                    type="button"
                    className="ap-chip"
                    onClick={() =>
                      revealed[k.id]
                        ? setRevealed((r) => {
                            const n = { ...r };
                            delete n[k.id];
                            return n;
                          })
                        : onReveal(k.id)
                    }
                  >
                    {revealed[k.id] ? "Hide" : "Reveal"}
                  </button>
                  <button type="button" className="ap-chip" onClick={() => onToggleKey(k)}>
                    {k.is_active ? "Disable" : "Enable"}
                  </button>
                  <button type="button" className="ap-chip" onClick={() => onRemoveKey(k.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="kie-addkey" onSubmit={onAddKey}>
          <input
            type="text"
            value={newKey.label}
            onChange={(e) => setNewKey((n) => ({ ...n, label: e.target.value }))}
            placeholder="Label (optional)"
          />
          <input
            type="password"
            className="kie-addkey-key"
            value={newKey.api_key}
            onChange={(e) => setNewKey((n) => ({ ...n, api_key: e.target.value }))}
            placeholder="Paste the Kie API key…"
            autoComplete="new-password"
          />
          <Button type="submit" variant="ghost" loading={busy === "addkey"} disabled={!provider}>
            Add key
          </Button>
        </form>
      </section>

      {/* -------------------------------------------------------------- test */}
      <section className="ap-panel">
        <header>
          <h3>Stream test</h3>
          <span className="ap-sub">
            Sends the exact payload below and reports every event Kie returned
          </span>
        </header>

        <form className="kie-test" onSubmit={onTest}>
          <input
            type="text"
            value={test.model}
            onChange={(e) => setT("model", e.target.value)}
            placeholder={form.default_model || DEFAULT_MODEL}
          />
          <input
            type="text"
            className="kie-test-prompt"
            value={test.prompt}
            onChange={(e) => setT("prompt", e.target.value)}
            placeholder="Say hello in one word."
          />
          <Button type="submit" loading={test.running === "test"}>
            Run test
          </Button>
        </form>

        <div className="kie-grid" style={{ marginTop: 12 }}>
          <label className="kie-field kie-wide kie-mono">
            <span>input_image URL (optional — switches input to the parts array)</span>
            <input
              type="url"
              value={test.imageUrl}
              onChange={(e) => setT("imageUrl", e.target.value)}
              placeholder={DOC_IMAGE}
            />
          </label>

          <label className="kie-field kie-check">
            <input
              type="checkbox"
              checked={test.webSearch}
              onChange={(e) => setT("webSearch", e.target.checked)}
            />
            <span>
              tools <code>[{'{ "type": "web_search" }'}]</code>
            </span>
          </label>

          <label className="kie-field">
            <span>reasoning.effort</span>
            <select value={test.effort} onChange={(e) => setT("effort", e.target.value)}>
              <option value="">(omit)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>

          <div className="kie-field kie-wide kie-mono">
            <span>Request body sent to Kie</span>
            <pre className="kie-preview">{pretty(request)}</pre>
          </div>
        </div>

        <div className="kie-actions">
          <Button type="button" variant="ghost" loading={test.running === "probe"} onClick={onProbe}>
            Run doc probe (A + B)
          </Button>
        </div>

        {test.err ? (
          <div style={{ marginTop: 12 }}>
            <Alert tone="error" title="Test failed">
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{test.err}</pre>
            </Alert>
          </div>
        ) : null}

        {test.out ? <KieResult title={test.out.model || "result"} result={test.out} /> : null}

        {test.probe?.runs?.length
          ? test.probe.runs.map((run) => (
              <KieResult
                key={run.name}
                title={run.name}
                result={{ ...run, analysis: run.analysis, ok: run.analysis?.ok }}
              />
            ))
          : null}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   One result block: the answer, then everything else Kie sent back.
--------------------------------------------------------------------------- */
function KieResult({ title, result }) {
  const a = result?.analysis || {};
  const ok = result?.ok !== false && a.ok !== false;
  const byType = a.events_by_type || {};
  const types = Object.keys(byType).sort((x, y) => byType[y] - byType[x]);

  return (
    <div className="kie-out">
      <div className="kie-out-head">
        <span className={`kie-st kie-st-${ok ? "working" : "failing"}`}>{ok ? "ok" : "failed"}</span>
        <span>
          {title} · HTTP {a.status ?? "?"} · {a.content_type || "?"} · {a.event_count ?? 0} events ·{" "}
          {a.delta_count ?? 0} text deltas · {a.ms ?? "?"} ms
          {a.first_delta_ms != null ? ` · first delta ${a.first_delta_ms} ms` : ""}
        </span>
      </div>

      {result?.request ? (
        <>
          <div className="kie-out-label">request</div>
          <pre>{pretty(result.request)}</pre>
        </>
      ) : null}

      <div className="kie-out-label">output_text</div>
      <pre>{a.text || result?.text || "(no text returned)"}</pre>

      {a.reasoning ? (
        <>
          <div className="kie-out-label">reasoning summary</div>
          <pre>{a.reasoning}</pre>
        </>
      ) : null}

      {a.refusal ? (
        <>
          <div className="kie-out-label">refusal</div>
          <pre>{a.refusal}</pre>
        </>
      ) : null}

      <div className="kie-out-label">usage · credits_consumed</div>
      <pre>
        {pretty({
          usage: a.usage ?? null,
          credits_consumed: a.credits_consumed ?? null,
          response_id: a.response_id ?? null,
          response_model: a.response_model ?? null,
          response_status: a.response_status ?? null,
          incomplete_details: a.incomplete_details ?? null,
          bytes: a.bytes ?? null,
        })}
      </pre>

      {types.length ? (
        <>
          <div className="kie-out-label">event types</div>
          <pre>{types.map((t) => `${String(byType[t]).padStart(4, " ")}  ${t}`).join("\n")}</pre>
        </>
      ) : null}

      {a.event_order?.length ? (
        <>
          <div className="kie-out-label">event order</div>
          <pre>{a.event_order.join("\n")}</pre>
        </>
      ) : null}

      {a.tool_calls?.length ? (
        <>
          <div className="kie-out-label">tool calls</div>
          <pre>{pretty(a.tool_calls)}</pre>
        </>
      ) : null}

      {a.annotations?.length ? (
        <>
          <div className="kie-out-label">annotations (web_search citations)</div>
          <pre>{pretty(a.annotations)}</pre>
        </>
      ) : null}

      {a.output_items?.length ? (
        <>
          <div className="kie-out-label">output items</div>
          <pre>{pretty(a.output_items)}</pre>
        </>
      ) : null}

      {a.unmapped_event_samples?.length ? (
        <>
          <div className="kie-out-label">unmapped events (raw samples)</div>
          <pre>{pretty(a.unmapped_event_samples)}</pre>
        </>
      ) : null}

      {a.error ? (
        <>
          <div className="kie-out-label">error</div>
          <pre>{pretty(a.error)}</pre>
        </>
      ) : null}

      {a.raw_tail ? (
        <>
          <div className="kie-out-label">raw tail</div>
          <pre>{a.raw_tail}</pre>
        </>
      ) : null}
    </div>
  );
}
