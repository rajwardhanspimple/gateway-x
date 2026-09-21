import React, { useEffect, useMemo, useState } from "react";
import { useSession } from "../lib/auth.js";
import { getSettings, listPublicModels, routeHealth } from "../lib/db.js";
import { GATEWAY_URL, isConfigured } from "../lib/supabase.js";
import { compact, copy, num } from "../lib/format.js";

/* ==========================================================================
   Landing, v9 — "grid paper"
   --------------------------------------------------------------------------
   Nothing from the v8 landing survives: no navy fold, no lime button, no
   serif headline. The fold is now one enormous wordmark on ruled paper, a
   three-line claim, one solid action, and a palette list that swaps the whole
   page between the paper and ink themes. Below it, a ruled canvas where live
   route cards float around a command bar that types real prompts.

   Every class is `fl-` and lives in styles/flim.css.
   ========================================================================== */

const STEPS = [
  ["01", "Store the origin once", "Base URL, auth scheme and keys go into your own Postgres. Nothing upstream ever reaches a browser."],
  ["02", "Publish your own ids", "Map a public name like rs-core onto the upstream model. Callers only learn the left-hand side."],
  ["03", "Compress the prompt", "Named token compressors rewrite the payload before it is forwarded, so you pay for fewer tokens."],
  ["04", "Issue gateway keys", "Customers mint rs_live_ keys, call your endpoint with any OpenAI-compatible SDK, and get metered per request."],
];

const SEALED = [
  ["upstream.base_url", "never leaves Postgres"],
  ["upstream.api_key", "server side only"],
  ["upstream.model", "rewritten on the way out"],
  ["upstream.error", "normalised before it ships"],
];

const PROMPTS = [
  "POST /v1/chat/completions",
  "model: rs-core",
  "compressor: prompt diet",
  "saved 38% of the prompt",
];

const PALETTES = [
  ["paper", "light"],
  ["ink", "dark"],
];

/* the floating cards on the canvas: [top, left, class, title, body] */
const FLOATS = [
  ["6%", "2%", "", "route", "rs-core → sealed"],
  ["14%", "26%", "is-citron keep-mobile", "compressed", "1,204 → 742 tokens"],
  ["4%", "57%", "", "key health", "working · 12ms check"],
  ["30%", "73%", "is-ink", "metered", "per request, per key"],
  ["62%", "5%", "is-ink keep-mobile", "failover", "next key, same answer"],
  ["70%", "40%", "", "logged", "tokens in / out / saved"],
  ["56%", "78%", "is-citron", "your domain", "api.yourdomain"],
];

export default function Home() {
  const { isAuthed } = useSession();
  const [models, setModels] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [brand, setBrand] = useState("RageStar");
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!isConfigured) return;
    Promise.all([listPublicModels(), routeHealth(), getSettings()])
      .then(([m, r, s]) => {
        setModels(m || []);
        setRoutes(r || []);
        if (s?.brand_name) setBrand(s.brand_name);
      })
      .catch(() => {});
  }, []);

  /* the command bar types one line, holds, then moves to the next */
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setTyped(PROMPTS[0]);
      return;
    }
    let line = 0;
    let char = 0;
    let hold = 0;
    const tick = window.setInterval(() => {
      if (hold > 0) {
        hold -= 1;
        if (hold === 0) {
          line = (line + 1) % PROMPTS.length;
          char = 0;
          setTyped("");
        }
        return;
      }
      char += 1;
      setTyped(PROMPTS[line].slice(0, char));
      if (char >= PROMPTS[line].length) hold = 14;
    }, 90);
    return () => window.clearInterval(tick);
  }, []);

  const onPalette = (next) => {
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    window.dispatchEvent(new CustomEvent("ragestar-theme-change", { detail: next }));
  };

  const requests24h = routes.reduce((a, r) => a + Number(r.requests_24h || 0), 0);
  const ok24h = routes.reduce((a, r) => a + Number(r.ok_24h || 0), 0);
  const upstreams = new Set(routes.map((r) => r.upstream_id || r.upstream || "")).size;
  const delivered = requests24h > 0 ? ((ok24h / requests24h) * 100).toFixed(1) : null;

  const base = GATEWAY_URL || "configure VITE_GATEWAY_URL";
  const host = useMemo(
    () =>
      GATEWAY_URL
        ? GATEWAY_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "").split("/")[0]
        : "api.yourdomain",
    [],
  );

  const VISIBLE = [
    ["base_url", host],
    ["model", models[0]?.public_id || "rs-core"],
    ["authorization", "rs_live_…"],
    ["x-rs-tokens-saved", "38%"],
  ];

  const snippet = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $RAGESTAR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "rs-core",
    "messages": [{ "role": "user", "content": "ping" }]
  }'`;

  const onCopy = () => {
    copy(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const dash = "\u2014";

  return (
    <main id="main" className="fl">
      {/* ============================================================ fold */}
      <section className="fl-hero">
        <h1 className="fl-word">
          Rage<em>Star</em>
        </h1>

        <div className="fl-claimcol">
          <p className="fl-claim">
            <span>The gateway sidekick.</span>
            <span>Built for <b>resellers</b>.</span>
            <span>Tuned for tokens.</span>
          </p>

          <a className="fl-cta" href={isAuthed ? "#/dashboard" : "#/signup"}>
            <span className="fl-cta-chip" aria-hidden="true">✦</span>
            <span>{isAuthed ? "Open dashboard" : "Sign up now"}</span>
          </a>
          <span className="fl-cta-sub">
            {isConfigured ? `${num(models.length)} public models · ${num(upstreams)} upstreams` : "demo mode · no database connected"}
          </span>
        </div>

        <div className="fl-themes" aria-label="Palette">
          <span>Palette</span>
          {PALETTES.map(([label, value]) => (
            <button
              key={value}
              type="button"
              className="fl-theme-row"
              aria-pressed={theme === value}
              onClick={() => onPalette(value)}
            >
              <span>{label}</span>
              <i aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="fl-theme-row" onClick={() => (window.location.hash = "#/models")}>
            <span>catalogue</span>
            <i aria-hidden="true" />
          </button>
          <button type="button" className="fl-theme-row" onClick={() => (window.location.hash = "#/docs")}>
            <span>quickstart</span>
            <i aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* ========================================================== canvas */}
      <section className="fl-canvas" aria-label="What the gateway does with a request">
        {FLOATS.map(([top, left, cls, title, body]) => (
          <div
            key={title}
            className={`fl-float ${cls}`}
            style={{ top, left, animationDelay: `${(parseInt(left, 10) % 5) * 0.6}s` }}
          >
            <b>{title}</b>
            {body}
          </div>
        ))}

        <div className="fl-bar">
          <span className="fl-bar-text">
            {typed}
            <i className="fl-bar-caret" aria-hidden="true" />
          </span>
          <a className="fl-bar-btn" href="#/docs">
            <span>Try it</span>
            <kbd>⌘/</kbd>
          </a>
        </div>
      </section>

      {/* ========================================================= metrics */}
      <section className="fl-sec is-card">
        <div className="fl-strip">
          <div className="fl-metric">
            <div className="k">Public models</div>
            <div className="v">{isConfigured ? num(models.length) : dash}</div>
            <div className="n">ids you own</div>
          </div>
          <div className="fl-metric">
            <div className="k">Requests 24h</div>
            <div className="v">{isConfigured ? compact(requests24h) : dash}</div>
            <div className="n">through your endpoint</div>
          </div>
          <div className="fl-metric">
            <div className="k">Delivered</div>
            <div className="v">{delivered ? `${delivered}%` : dash}</div>
            <div className="n">after failover</div>
          </div>
          <div className="fl-metric">
            <div className="k">Upstreams</div>
            <div className="v">{isConfigured ? num(upstreams) : dash}</div>
            <div className="n">hidden behind one URL</div>
          </div>
          <div className="fl-metric">
            <div className="k">Compressors</div>
            <div className="v">4</div>
            <div className="n">stacked, priority ordered</div>
          </div>
        </div>
      </section>

      {/* =========================================================== steps */}
      <section className="fl-sec is-paper">
        <div className="fl-sec-head">
          <div>
            <span className="fl-label">How it works</span>
            <h2>Four moves between your customer and the provider</h2>
          </div>
          <p>
            {brand} owns the request from the moment it leaves the SDK: it resolves a
            route, shrinks the prompt, picks a healthy key, and logs what it cost.
          </p>
        </div>
        <div className="fl-steps">
          {STEPS.map(([n, title, body]) => (
            <div className="fl-step" key={n}>
              <i>{n}</i>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ======================================================== sealed vs */}
      <section className="fl-sec is-card">
        <div className="fl-sec-head">
          <div>
            <span className="fl-label">Surface area</span>
            <h2>What a caller sees, and what stays sealed</h2>
          </div>
        </div>
        <div className="fl-split">
          <div>
            <span className="fl-label">Visible to the caller</span>
            <div className="fl-rows" style={{ marginTop: 10 }}>
              {VISIBLE.map(([k, v]) => (
                <div className="fl-row" key={k}>
                  <span>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <span className="fl-label">Sealed in your database</span>
            <div className="fl-rows" style={{ marginTop: 10 }}>
              {SEALED.map(([k, v]) => (
                <div className="fl-row is-sealed" key={k}>
                  <span>{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ============================================== token compression */}
      <section className="fl-sec is-paper">
        <div className="fl-sec-head">
          <div>
            <span className="fl-label">New · token compressors</span>
            <h2>Pay for the prompt you meant to send</h2>
          </div>
          <p>
            Build as many compressors as you need, order them by priority, and
            watch the estimated saving per stage before anything is enabled.
          </p>
        </div>
        <div className="fl-tiles">
          <div className="fl-tile">
            <b>Tidy · lossless</b>
            <div className="v">−11%</div>
            <p>Whitespace, markdown decoration, duplicate lines.</p>
          </div>
          <div className="fl-tile">
            <b>Prompt diet</b>
            <div className="v">−26%</div>
            <p>Filler phrases out, fixed abbreviation dictionary in.</p>
          </div>
          <div className="fl-tile">
            <b>History squeeze</b>
            <div className="v">−44%</div>
            <p>Older turns only, middle-out truncation past the budget.</p>
          </div>
          <div className="fl-tile">
            <b>JSON slim</b>
            <div className="v">−31%</div>
            <p>Minifies pasted payloads and strips HTML from tool output.</p>
          </div>
        </div>
      </section>

      {/* ============================================================ code */}
      <section className="fl-sec is-card">
        <div className="fl-split">
          <div>
            <span className="fl-label">Drop-in</span>
            <h2 style={{ margin: "8px 0 10px" }}>Same SDK, one base URL change</h2>
            <p className="muted" style={{ fontSize: 14, maxWidth: "44ch" }}>
              Any OpenAI-compatible client works unchanged. Point it at your host,
              hand it a key you issued, and the response comes back with your
              model id — plus a header telling you how many tokens the
              compressors removed.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <a className="btn btn-primary btn-sm" href="#/docs">Read the docs</a>
              <a className="btn btn-ghost btn-sm" href="#/models">Browse models</a>
            </div>
          </div>
          <div className="fl-code">
            <div className="fl-code-top">
              <span>shell</span>
              <button type="button" onClick={onCopy}>{copied ? "copied" : "copy"}</button>
            </div>
            <pre>{snippet}</pre>
          </div>
        </div>
      </section>

      {/* ============================================================= end */}
      <section className="fl-end">
        <span className="fl-label">Your API in front of theirs</span>
        <h2>Ship the gateway, keep the keys</h2>
        <p>
          Self-hosted on your Supabase project and your domain. Routing, credits,
          IP rules, token compression and audit trail included.
        </p>
        <div className="fl-end-actions">
          <a className="btn btn-primary" href={isAuthed ? "#/dashboard" : "#/signup"}>
            {/* the same ✦ mark the hero CTA carries, so the primary action
                reads as one visual language across the page */}
            <span className="fl-cta-star" aria-hidden="true">✦</span>
            {isAuthed ? "Open dashboard" : "Create an API key"}
          </a>
          <a className="btn btn-ghost" href="#/pricing">See pricing</a>
        </div>
      </section>
    </main>
  );
}
