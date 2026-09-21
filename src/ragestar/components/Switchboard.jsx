/* ==========================================================================
   Switchboard — patch a request through, by hand
   --------------------------------------------------------------------------
   An exchange operator's board. The jack field on the left is every published
   model. Press a jack and the patch cord draws across to the RageStar socket.
   Type a prompt and send: the board shows the exact request that would route
   through the gateway for that model.

   HONESTY RULE. The gateway needs a bearer key. The playground holds its key
   in component state only, never in storage — a long-lived credential does not
   belong anywhere a script on the origin can read it — so there is no key for
   a landing-page visitor to borrow, and this board does not ask for one on a
   public page.

   So the board never sends. It patches the cord, prints the EXACT curl for
   that model against the configured gateway with the visitor's own prompt in
   it, and points at the playground. Nothing is typed out pretending to be a
   reply. A fake response on a page whose whole claim is "this routes for real"
   would undercut the claim; a real request needs a real key, and the place
   for that is behind sign-in.

   What IS real here: the model list (public_models), the gateway URL, and the
   request body. Copy the curl, add a key, and it runs.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { models as fixtureModels } from "../dashboard/data.js";
import { useCatalog } from "../lib/workspace.js";
import { API_BASE, API_IS_REAL } from "../lib/gateway.js";

/** The cord: a cubic from the jack field's edge to the star socket. */
function CordSvg() {
  return (
    <svg viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        className="lp-cord-path"
        pathLength="1"
        d="M 0 36 C 22 36, 30 54, 50 54 S 78 36, 86 36"
      />
      <circle className="lp-cord-plug" cx="86" cy="36" r="3.2" />
      <circle className="lp-cord-star" cx="92" cy="36" r="5" />
    </svg>
  );
}

function curlFor(model, text) {
  const body = JSON.stringify({
    model: model.id,
    messages: [{ role: "user", content: text }],
  });
  return [
    `curl ${API_BASE}/chat/completions \\`,
    `  -H "Authorization: Bearer $RAGESTAR_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${body.replace(/'/g, "'\\''")}'`,
  ].join("\n");
}

export default function Switchboard({ navigate }) {
  const catalog = useCatalog();
  const rows = catalog ?? fixtureModels;
  const [modelId, setModelId] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [lines, setLines] = useState([]); /* { k, v, tone } */
  const [copied, setCopied] = useState(false);
  const transcript = useRef(null);

  const model = useMemo(() => rows.find((m) => m.id === modelId) ?? null, [rows, modelId]);

  /* keep the tape scrolled to the newest line */
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const patch = (id) => {
    setModelId((cur) => (cur === id ? null : id));
    setLines([]);
    setCopied(false);
  };

  const send = (e) => {
    e?.preventDefault?.();
    const text = prompt.trim();
    if (!text || !model) return;
    setPrompt("");
    setCopied(false);
    const stamp = new Date().toISOString().slice(11, 19);
    setLines([
      { k: stamp, v: `> ${model.id}`, tone: "" },
      { k: "you", v: text, tone: "" },
      { k: "request", v: curlFor(model, text), tone: "", curl: true },
      {
        k: "note",
        v: API_IS_REAL
          ? "This is the exact call. Add your key and it routes. Try it live in the playground."
          : "The gateway is not configured in this build, so the request is shown rather than sent.",
        tone: "",
      },
    ]);
  };

  const copyCurl = async () => {
    const line = lines.find((l) => l.curl);
    if (!line) return;
    try {
      await navigator.clipboard.writeText(line.v);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the text is selectable on screen */
    }
  };

  const hasCurl = lines.some((l) => l.curl);

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
          >
            <span className="lp-socket" aria-hidden="true" />
            <span className="lp-jack-name">{m.id}</span>
            {m.context ? <span className="lp-jack-meta">{Math.round(m.context / 1000)}k</span> : null}
          </button>
        ))}
      </div>

      <div className="lp-operator">
        <div className="lp-cord" data-patched={Boolean(model)}>
          <CordSvg />
          <span className="lp-cord-label">{model ? `${model.id} patched to RageStar` : "pick a line"}</span>
        </div>

        <div className="lp-transcript" ref={transcript} aria-live="polite" aria-label="Transcript">
          {lines.length === 0 ? (
            <p className="lp-transcript-empty">
              {model
                ? `Line open to ${model.id}. Type a prompt and send it to see the exact request.`
                : "Press a jack on the left to open a line. Then send a prompt through it and see the request RageStar would route."}
            </p>
          ) : (
            <>
              {lines.map((l, i) => (
                <div key={i} className="lp-transcript-line">
                  <span className="lp-transcript-k">{l.k}</span>
                  <span className={`lp-transcript-v${l.tone ? ` lp-transcript-v--${l.tone}` : ""}`}>{l.v}</span>
                </div>
              ))}
              {hasCurl ? (
                <div className="lp-transcript-actions">
                  <button type="button" className="lp-link" onClick={copyCurl}>
                    {copied ? "Copied" : "Copy the request"}
                  </button>
                  {API_IS_REAL && navigate ? (
                    <button type="button" className="lp-link" onClick={() => navigate("login")}>
                      Run it in the playground
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        <form className="lp-prompt" onSubmit={send}>
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={model ? "Say something to the model" : "Open a line first"}
            disabled={!model}
            aria-label="Prompt"
            autoComplete="off"
          />
          <button type="submit" className="lp-btn lp-btn--fill" disabled={!model || !prompt.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
