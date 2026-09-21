import React, { useEffect, useState } from "react";
import { Button } from "../components/ui/index.jsx";
import { listPublicModels } from "../lib/db.js";
import { isConfigured, GATEWAY_URL, SUPABASE_URL } from "../lib/supabase.js";
import { copy } from "../lib/format.js";

function Code({ children, label }) {
  const [done, setDone] = useState(false);
  return (
    <div className="adm-card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="row-between" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
        <span className="faint xs mono">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await copy(children);
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          }}
        >
          {done ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mono xs" style={{ margin: 0, padding: 14, overflowX: "auto" }}>{children}</pre>
    </div>
  );
}

const SECTIONS = [
  ["quickstart", "Quickstart"],
  ["auth", "Authentication"],
  ["endpoints", "Endpoints"],
  ["streaming", "Streaming"],
  ["headers", "Response headers"],
  ["errors", "Errors"],
  ["privacy", "Upstream privacy"],
  ["deploy", "Deploying this stack"],
];

export default function Docs() {
  const [models, setModels] = useState([]);

  useEffect(() => {
    if (!isConfigured) return;
    listPublicModels()
      .then((r) => setModels(r || []))
      .catch(() => {});
  }, []);

  const base = GATEWAY_URL || "https://<your-project>.supabase.co/functions/v1/router/v1";
  const model = models[0]?.id || "your-model-id";

  return (
    <main id="main">
      <section className="section">
        <div className="container">
          <div className="adm">
            <nav className="adm-rail" aria-label="Documentation sections">
              <div className="adm-rail-head">
                <span>
                  <b>Docs</b>
                  <small>OpenAI-compatible gateway</small>
                </span>
              </div>
              {SECTIONS.map(([id, label]) => (
                <a key={id} className="adm-tab" href={`#/docs`} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}>
                  {label}
                </a>
              ))}
            </nav>

            <div className="adm-body">
              <div className="adm-head" data-rv>
                <div>
                  <span className="eyebrow">documentation</span>
                  <h1>Use your gateway</h1>
                  <p>
                    The gateway speaks the OpenAI HTTP shape. Point any compatible SDK
                    at your base URL and use a key you minted in the console.
                  </p>
                </div>
              </div>

              <div id="quickstart" className="adm-card" data-rv>
                <h2>1. Quickstart</h2>
                <p className="sub">Base URL for this deployment:</p>
                <div className="reveal-box">
                  <code>{base}</code>
                  <Button size="sm" variant="ghost" onClick={() => copy(base)}>Copy</Button>
                </div>
              </div>

              <Code label="curl">{`curl ${base}/chat/completions \\
  -H "authorization: Bearer rs_live_your_key" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`}</Code>

              <Code label="python · openai sdk">{`from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="rs_live_your_key",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)`}</Code>

              <Code label="node · openai sdk">{`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.RAGESTAR_API_KEY, // rs_live_…
});

const r = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);`}</Code>

              <div id="auth" className="adm-card">
                <h2>2. Authentication</h2>
                <p className="sub">
                  Send your gateway key as a bearer token. Keys are created in the
                  console, stored as SHA-256 hashes, and can carry a monthly budget,
                  a rate limit and an allow-list of models.
                </p>
                <ul className="stack small muted">
                  <li><code className="mono">rs_live_…</code> — production keys</li>
                  <li><code className="mono">rs_test_…</code> — keys you can revoke freely</li>
                  <li>Revoked or over-budget keys return <code className="mono">401</code> / <code className="mono">402</code></li>
                </ul>
              </div>

              <div id="endpoints" className="adm-card">
                <h2>3. Endpoints</h2>
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
                    <tbody>
                      <tr><td className="mono">GET</td><td className="mono">/v1/models</td><td>List the models you published</td></tr>
                      <tr><td className="mono">POST</td><td className="mono">/v1/chat/completions</td><td>Chat completion, streaming or not</td></tr>
                      <tr><td className="mono">POST</td><td className="mono">/v1/completions</td><td>Legacy text completion</td></tr>
                      <tr><td className="mono">POST</td><td className="mono">/v1/embeddings</td><td>Embeddings, when the upstream supports it</td></tr>
                      <tr><td className="mono">GET</td><td className="mono">/health</td><td>Liveness ping, no key required</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div id="streaming" className="adm-card">
                <h2>4. Streaming</h2>
                <p className="sub">Set <code className="mono">"stream": true</code>. Chunks are proxied as they arrive and rewritten so the model id you see is always your public id.</p>
              </div>

              <div id="headers" className="adm-card">
                <h2>5. Response headers</h2>
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>Header</th><th>Meaning</th></tr></thead>
                    <tbody>
                      <tr><td className="mono">x-rs-request-id</td><td>Correlates with your request_logs row</td></tr>
                      <tr><td className="mono">x-rs-model</td><td>The public model id that served the call</td></tr>
                      <tr><td className="mono">x-rs-policy</td><td>Routing policy applied</td></tr>
                      <tr><td className="mono">x-rs-failover</td><td>How many hops were needed</td></tr>
                      <tr><td className="mono">x-rs-latency-ms</td><td>Upstream latency</td></tr>
                      <tr><td className="mono">x-rs-tokens-in / out</td><td>Token accounting</td></tr>
                      <tr><td className="mono">x-rs-cost-usd</td><td>Cost from your own price table</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="faint xs mt-2">There is deliberately no header that names an upstream provider.</p>
              </div>

              <div id="errors" className="adm-card">
                <h2>6. Errors</h2>
                <Code label="error shape">{`{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}`}</Code>
                <ul className="stack small muted mt-4">
                  <li><b>401</b> unknown, revoked or disabled key</li>
                  <li><b>402</b> monthly budget exhausted</li>
                  <li><b>403</b> the workspace gates the API on Discord — <code className="mono">discord_not_linked</code> or <code className="mono">discord_not_in_server</code>; link Discord and join the community server from Profile → Discord</li>
                  <li><b>404</b> model id not published</li>
                  <li><b>429</b> per-key rate limit</li>
                  <li><b>503</b> every upstream key for that model failed</li>
                </ul>
              </div>

              <div id="privacy" className="adm-card">
                <h2>7. Upstream privacy</h2>
                <p className="sub">How the original API stays hidden:</p>
                <ul className="stack small muted">
                  <li>Upstream base URL, paths and headers live in the <code className="mono">upstreams</code> table, which the browser role cannot read.</li>
                  <li>Upstream API keys live in <code className="mono">upstream_keys</code>. Admin reads go through a masked view; the raw value only comes back from an audited reveal function.</li>
                  <li>The Edge Function strips upstream hosts, upstream model ids and key fragments from bodies, error messages and streamed chunks.</li>
                  <li>Logs record your public model id only — there is no upstream column to leak.</li>
                </ul>
              </div>

              <div id="deploy" className="adm-card">
                <h2>8. Deploying this stack</h2>
                <Code label="terminal">{`# 1. database
#    paste supabase/schema.sql into the Supabase SQL editor, or:
supabase db push            # uses scripts/apply-schema.sh under the hood

# 2. gateway + key checker
supabase functions deploy router --no-verify-jwt
supabase functions deploy admin-check-keys --no-verify-jwt

# 3. frontend
cp .env.example .env        # add VITE_SUPABASE_ANON_KEY
npm install && npm run dev`}</Code>
                <p className="faint xs mt-2">Project: {SUPABASE_URL || "set VITE_SUPABASE_URL"}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
