/* ==========================================================================
   Switchboard — patch a request through, by hand
   --------------------------------------------------------------------------
   An exchange operator's board. The jack field on the left is every published
   model. Press a jack and the patch cord draws across to the RageStar socket.
   Type a prompt and send: the request goes through the real gateway, the same
   POST /chat/completions an SDK makes, and the reply types back on the telex.

   HONESTY RULE. The gateway needs a bearer key, and a signed-out visitor on
   the landing page does not have one. So:

     with a key      the call is real, streamed, and the transcript shows the
                     model that actually answered, its first-token time and
                     the wall clock, from the response headers
     without a key   the board still patches the cord and shows the EXACT curl
                     for that model against the configured gateway, then
                     points at sign-up. Nothing is typed out pretending to be
                     a reply. A fake response on a page whose whole claim is
                     "this routes for real" would undercut the claim.

   The key comes from `sessionStorage` (the playground stores it there for the
   session) and never from a prop, so it is never in the page's markup.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { models as fixtureModels } from "../dashboard/data.js";
import { useCatalog } from "../lib/workspace.js";
import { API_BASE, API_IS_REAL } from "../lib/gateway.js";
import { streamGateway } from "../../lib/db.js";

const KEY_STORE = "rs-playground-key";
const SYSTEM = "You are a concise assistant. Answer in one or two sentences.";

function readKey() {
  try {
    return (sessionStorage.getItem(KEY_STORE) || "").trim();
  } catch {
    return "";
  }
}

/** The cord: a cubic from the jack field's edge to the star socket. */
function CordSvg({ patched }) {
  /* viewBox is 100 wide so the path scales with the panel; the plug and star
     sit at fixed positions on that grid */
  return (
    <svg viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        className="lp-cord-path"
        pathLength="1"
        d="M 0 36 C 22 36, 30 54, 50 54 S 78 36, 86 36"
      />
      <circle className="lp-cord-plug" cx="86" cy="36" r="3.2" />
      <circle className="lp-cord-star" cx="92" cy="36" r="5" />
      {patched ? null : null}
    </svg>
  );
}

export default function Switchboard() {
  const catalog = useCatalog();
  const rows = catalog ?? fixtureModels;
  const [modelId, setModelId] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [lines, setLines] = useState([]); /* { k, v, tone } */
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const abort = useRef(null);
  const transcript = useRef(null);

  useEffect(() => {
    setKey(readKey());
  }, []);

  const model = useMemo(() => rows.find((m) => m.id === modelId) ?? null, [rows, modelId]);

  /* keep the tape scrolled to the newest line */
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const patch = (id) => {
    if (busy) return;
    setModelId((cur) => (cur === id ? null : id));
    setLines([]);
  };

  const curlFor = (m, text) =>
    `curl ${API_BASE}/chat/completions \\\n  -H "Authorization: Bearer $RAGESTAR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${m.id}","messages":[{"role":"user","content":${JSON.stringify(text)}}]}'`;

  const send = async (e) => {
    e?.preventDefault?.();
    const text = prompt.trim();
    if (!text || !model || busy) return;
    setPrompt("");

    const stamp = new Date().toISOString().slice(11, 19);
    const out = [
      { k: stamp, v: `> ${model.id}`, tone: "" },
      { k: "you", v: text, tone: "" },
    ];

    if (!key || !API_IS_REAL) {
      /* no key: show the real call, do not fake the answer */
      setLines([
        ...out,
        { k: "request", v: curlFor(model, text), tone: "" },
        {
          k: "note",
          v: API_IS_REAL
            ? "Add an API key in the playground and this board sends the request for real. Create a workspace to get one."
            : "The gateway is not configured in this build, so the request is shown rather than sent.",
          tone: "",
        },
      ]);
      return;
    }

    setBusy(true);
    setLines([...out, { k: "gateway", v: "", tone: "ok", streaming: true }]);
    const controller = new AbortController();
    abort.current = controller;
    let acc = "";
    try {
      const result = await streamGateway({
        apiKey: key,
        model: model.id,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
        temperature: 0.7,
        topP: 1,
        maxTokens: 160,
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          setLines((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { k: "gateway", v: acc, tone: "ok", streaming: true };
            return copy;
          });
        },
      });
      const served = result?.headers?.model || result?.model || model.id;
      const ttft = result?.ttft ?? result?.firstToken;
      const wall = result?.elapsed ?? result?.total;
      setLines((prev) => [
        ...prev.slice(0, -1),
        { k: "gateway", v: acc, tone: "ok" },
        {
          k: "served",
          v: [served, ttft ? `first token ${ttft} ms` : null, wall ? `${wall} ms total` : null]
            .filter(Boolean)
            .join("  "),
          tone: "",
        },
      ]);
    } catch (err) {
      if (err?.name !== "AbortError") {
        setLines((prev) => [
          ...prev.slice(0, -1),
          ...(acc ? [{ k: "gateway", v: acc, tone: "ok" }] : []),
          { k: "error", v: err?.message || "The gateway call failed.", tone: "err" },
        ]);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  useEffect(() => () => abort.current?.abort(), []);

  return (
    <div className="lp-board">
      <div className="lp-jackfield" role="group" aria-label="Models">
        <div className="lp-jackfield-title">
          {rows.length} lines{catalog == null ? ", connecting" : ""}
        </div>
        {rows.map((m) => (
          <button
            key={m.id}
            type="button"
            className="lp-jack"
            aria-pressed={modelId === m.id}
            onClick={() => patch(m.id)}
            disabled={busy && modelId !== m.id}
          >
            <span className="lp-socket" aria-hidden="true" />
            <span className="lp-jack-name">{m.id}</span>
            {m.context ? <span className="lp-jack-meta">{Math.round(m.context / 1000)}k</span> : null}
          </button>
        ))}
      </div>

      <div className="lp-operator">
        <div className="lp-cord" data-patched={Boolean(model)}>
          <CordSvg patched={Boolean(model)} />
          <span className="lp-cord-label">{model ? `${model.id} patched to RageStar` : "pick a line"}</span>
        </div>

        <div className="lp-transcript" ref={transcript} aria-live="polite" aria-label="Transcript">
          {lines.length === 0 ? (
            <p className="lp-transcript-empty">
              {model
                ? `Line open to ${model.id}. Type a prompt and send it.`
                : "Press a jack on the left to open a line. Then send a prompt through it and watch which model answers, and how fast."}
            </p>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="lp-transcript-line">
                <span className="lp-transcript-k">{l.k}</span>
                <span className={`lp-transcript-v${l.tone ? ` lp-transcript-v--${l.tone}` : ""}`}>
                  {l.v}
                  {l.streaming ? "\u2588" : ""}
                </span>
              </div>
            ))
          )}
        </div>

        <form className="lp-prompt" onSubmit={send}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={model ? "Say something to the model" : "Open a line first"}
            disabled={!model || busy}
            aria-label="Prompt"
            autoComplete="off"
          />
          <button type="submit" className="lp-btn lp-btn--fill" disabled={!model || busy || !prompt.trim()}>
            {busy ? "Sending" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
