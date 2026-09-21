/* ==========================================================================
   Landing — "Switchboard Orrery"
   --------------------------------------------------------------------------
   The RageStar landing page, rebuilt from a brief. See src/styles/landing.css
   for the brief, the palette and the rules. In one line: RageStar is the star,
   every model is in orbit, every request is a ray; drawn like a woodblock
   print of a telephone exchange.

   Seven folds, top to bottom:
     1. Hero          headline + the Orrery + three live figures
     2. Switchboard   vermilion field; patch a request through by hand
     3. Exchange      indigo field; failover, streaming, billing
     4. Line log      live requests as a telex tape
     5. Pricing       three plans, the recommended one IS the red field
     6. FAQ           native details/summary
     7. Close         indigo field; one headline, one action

   What is gone from the previous page and why:
     - Testimonials. Every quote was fabricated ("Maya Renton, VP Engineering,
       Lumen Motors"). The repo's own rule is that nothing on the marketing
       pages is invented, and a made-up customer is worse than a made-up
       number. They come back when there are real ones.
     - PartnerStrip. Same reason.
     - Reveal-on-scroll on every block, floating tiles, pointer parallax, the
       grain and sparks backdrop. Motion is the orrery's ray and the
       switchboard's cord. Everything else holds still.
     - All-caps eyebrows, mid-dot meta strings, the one-word-in-cobalt
       headline, rounded cards. See landing.css for the reasoning.

   Every figure on this page is live or absent. Nothing is filled in.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useState } from "react";
import Orrery from "./Orrery.jsx";
import Switchboard from "./Switchboard.jsx";
import { API_HOST } from "../lib/gateway.js";
import { isConfigured } from "../../lib/config.js";
import { routeHealth } from "../../lib/db.js";

/* ------------------------------------------------------------------ nav */

const NAV = [
  { label: "Models", to: "models" },
  { label: "Pricing", to: "pricing" },
  { label: "Docs", to: "docs" },
  { label: "Status", to: "status" },
];

export function LandingNav({ navigate, session }) {
  return (
    <header className="lp-nav">
      <div className="lp-wrap lp-nav-row">
        <button type="button" className="lp-brand" onClick={() => navigate("")} aria-label="RageStar, home">
          <span className="lp-brand-mark pr-brand-mark" aria-hidden="true" />
          RageStar
        </button>
        <nav className="lp-nav-links" aria-label="Site">
          {NAV.map((n) => (
            <button key={n.to} type="button" onClick={() => navigate(n.to)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="lp-nav-actions">
          <button type="button" className="lp-btn lp-btn--sm" onClick={() => navigate(session ? "dashboard" : "login")}>
            {session ? "Console" : "Sign in"}
          </button>
          <button type="button" className="lp-btn lp-btn--sm lp-btn--fill" onClick={() => navigate(session ? "dashboard/keys" : "signup")}>
            Get an API key
          </button>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------- figures */

function Figure({ n, unit, label }) {
  return (
    <div>
      <div className="lp-figure-n">
        {n}
        {unit ? <small>{unit}</small> : null}
      </div>
      <div className="lp-figure-l">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------- line log */

/** The last few models to carry traffic, from the public route_health view. */
function useLineLog() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    const load = () =>
      routeHealth()
        .then((r) => {
          if (!live) return;
          const list = (Array.isArray(r) ? r : [])
            .filter((x) => x.last_request_at)
            .sort((a, b) => new Date(b.last_request_at) - new Date(a.last_request_at))
            .slice(0, 8);
          setRows(list);
        })
        .catch(() => live && setRows(null));
    load();
    const t = window.setInterval(load, 30000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  return rows;
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/* ------------------------------------------------------------- content */

const EXCHANGE = [
  {
    title: "Failover that finishes the sentence",
    body: "If a provider drops mid-stream, the request moves to the next key or the next model and keeps going. The caller sees one response.",
    glyph: (
      <svg className="lp-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M3 16h9l4-8 4 16 4-8h5" />
      </svg>
    ),
  },
  {
    title: "Streaming, tool calls, vision",
    body: "OpenAI-compatible on the wire. Point an existing SDK at a new base URL and it works, including server-sent events and function calling.",
    glyph: (
      <svg className="lp-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M4 10h24M4 16h16M4 22h20" />
      </svg>
    ),
  },
  {
    title: "Metered per request",
    body: "Every call is logged with its tokens, cost, latency and the model that actually served it. Budgets and rate limits per key.",
    glyph: (
      <svg className="lp-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M6 26V6h20v20zM6 13h20M13 13v13" />
      </svg>
    ),
  },
];

const PLANS = [
  {
    name: "Developer",
    price: "$0",
    unit: "plus usage",
    note: "$25 credit to start",
    points: ["Every published model", "Streaming and tool calls", "Request log and usage sheet", "Community support"],
    cta: "Start free",
    to: "signup",
  },
  {
    name: "Scale",
    price: "$499",
    unit: "per month",
    note: "For teams routing production traffic",
    points: ["Higher rate limits", "Per-key budgets and alerts", "Priority failover", "Email support"],
    cta: "Talk to us",
    to: "pricing",
    featured: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    unit: "",
    note: "Dedicated capacity and an SLA",
    points: ["Dedicated upstreams", "Custom routing policy", "SSO and audit export", "Named support"],
    cta: "Contact sales",
    to: "pricing",
  },
];

const FAQ = [
  {
    q: "Do you train on my prompts or completions?",
    a: "The privacy policy sets this out in full and you accept it before the console opens. Read it before you send anything you would not want stored.",
  },
  {
    q: "How is pricing calculated?",
    a: "Per request, on the tokens in and out at the published rate for the model that served it. Every request's cost is in your log.",
  },
  {
    q: "What does routing actually do?",
    a: "You name a model. RageStar picks a working upstream key for it, sends the request, and if that upstream fails, moves to the next one without the caller noticing.",
  },
  {
    q: "Can I bring my own keys?",
    a: "Not on the Developer plan. Talk to us about Scale or Enterprise if you need to route through your own provider accounts.",
  },
  {
    q: "What happens when I hit a rate limit?",
    a: "A 429 with a Retry-After header, the same shape an SDK already handles. Limits are per key and shown in the console.",
  },
];

/* ---------------------------------------------------------------- page */

export default function Landing({ navigate, session }) {
  const [figures, setFigures] = useState(null);
  const log = useLineLog();
  const onFigures = useCallback((f) => setFigures(f), []);

  const fig = useMemo(() => {
    if (!figures) return null;
    return {
      models: figures.models,
      connected: figures.connected == null ? null : figures.connected.toFixed(2),
      latency: figures.latency,
      liveCatalog: figures.liveCatalog,
    };
  }, [figures]);

  return (
    <div className="lp">
      <LandingNav navigate={navigate} session={session} />

      <main id="main">
        {/* 1. hero */}
        <section className="lp-hero" aria-labelledby="lp-h1">
          <div className="lp-wrap">
            <div className="lp-hero-grid">
              <div className="lp-hero-copy">
                <h1 id="lp-h1" className="lp-display lp-h1">
                  Every frontier model.
                  <br />
                  One line.
                </h1>
                <p className="lp-lede">
                  Send a request to RageStar and it reaches whichever model you named, through whichever upstream is
                  answering. OpenAI-compatible, streamed, metered per call.
                </p>
                <div className="lp-hero-actions">
                  <button type="button" className="lp-btn lp-btn--fill" onClick={() => navigate(session ? "dashboard/keys" : "signup")}>
                    Get an API key
                  </button>
                  <button type="button" className="lp-link" onClick={() => navigate("docs")}>
                    Read the docs
                  </button>
                </div>
              </div>
              <Orrery onFigures={onFigures} />
            </div>

            <div className="lp-figures" aria-label="Live platform figures">
              <Figure
                n={fig ? fig.models : "\u2014"}
                label={fig?.liveCatalog ? "models in orbit, published now" : "models in orbit"}
              />
              <Figure
                n={fig?.connected ?? "\u2014"}
                unit={fig?.connected ? "%" : ""}
                label={fig?.connected ? "of requests answered, last 24 hours" : "awaiting traffic to report"}
              />
              <Figure
                n={fig?.latency ?? "\u2014"}
                unit={fig?.latency ? "ms" : ""}
                label={fig?.latency ? "average latency across models, 24h" : "awaiting traffic to report"}
              />
            </div>
          </div>
        </section>

        {/* 2. switchboard */}
        <section id="playground" className="lp-field lp-field--vermilion" aria-labelledby="lp-h-board">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="lp-h-board" className="lp-display lp-h2">
                Patch a request through.
              </h2>
              <p className="lp-lede">
                Open a line to any model on the board, send it something, and see the exact request RageStar routes.
                The base URL is <code>{API_HOST}</code>.
              </p>
            </div>
            <Switchboard navigate={navigate} />
          </div>
        </section>

        {/* 3. the exchange */}
        <section id="platform" className="lp-field lp-field--indigo" aria-labelledby="lp-h-exchange">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="lp-h-exchange" className="lp-display lp-h2">
                What the exchange does for you.
              </h2>
            </div>
            <div className="lp-exchange">
              {EXCHANGE.map((x) => (
                <div key={x.title} className="lp-panel">
                  {x.glyph}
                  <h3 className="lp-h3">{x.title}</h3>
                  <p>{x.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4. line log */}
        <section className="lp-field" aria-labelledby="lp-h-log">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="lp-h-log" className="lp-display lp-h2">
                Lines in use.
              </h2>
              <p className="lp-lede">The models that carried traffic most recently, from the public health view. Refreshes every thirty seconds.</p>
            </div>
            <div className="lp-log" role="table" aria-label="Recent lines">
              <div className="lp-log-row lp-log-row--head" role="row">
                <span role="columnheader">last</span>
                <span role="columnheader">model</span>
                <span role="columnheader" className="r">ms</span>
                <span role="columnheader" className="r">answered</span>
              </div>
              {log == null ? (
                <p className="lp-log-empty">{isConfigured ? "Connecting to the gateway." : "The gateway is not configured in this build."}</p>
              ) : log.length === 0 ? (
                <p className="lp-log-empty">No line has carried traffic yet.</p>
              ) : (
                log.map((r) => (
                  <div key={r.model} className="lp-log-row" role="row">
                    <span role="cell">{ago(r.last_request_at)} ago</span>
                    <span role="cell">{r.name || r.model}</span>
                    <span role="cell" className="r">{r.avg_latency_ms ?? "\u2014"}</span>
                    <span role="cell" className={`r ${Number(r.success_rate) >= 99 ? "lp-log-status--ok" : Number(r.success_rate) < 90 ? "lp-log-status--fail" : ""}`}>
                      {r.success_rate == null ? "\u2014" : `${Number(r.success_rate).toFixed(1)}%`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* 5. pricing */}
        <section id="pricing" className="lp-field" aria-labelledby="lp-h-pricing">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="lp-h-pricing" className="lp-display lp-h2">
                Pay for what you route.
              </h2>
            </div>
            <div className="lp-plans">
              {PLANS.map((p) => (
                <div key={p.name} className={`lp-plan${p.featured ? " lp-plan--featured" : ""}`}>
                  <h3 className="lp-h3">{p.name}</h3>
                  <div className="lp-plan-price">
                    {p.price}
                    {p.unit ? <small>{p.unit}</small> : null}
                  </div>
                  <p className="lp-plan-note">{p.note}</p>
                  <ul>
                    {p.points.map((pt) => (
                      <li key={pt}>{pt}</li>
                    ))}
                  </ul>
                  <button type="button" className={`lp-btn${p.featured ? "" : " lp-btn--fill"}`} onClick={() => navigate(p.to)}>
                    {p.cta}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 6. faq */}
        <section id="faq" className="lp-field" aria-labelledby="lp-h-faq">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="lp-h-faq" className="lp-display lp-h2">
                Questions people ask first.
              </h2>
            </div>
            <div className="lp-faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 7. close */}
        <section className="lp-field lp-field--indigo lp-close" aria-labelledby="lp-h-close">
          <div className="lp-wrap">
            <h2 id="lp-h-close" className="lp-display lp-h2">
              Open a line.
            </h2>
            <p className="lp-lede">A key takes a minute. The first $25 of usage is on us.</p>
            <div className="lp-hero-actions">
              <button type="button" className="lp-btn lp-btn--fill" onClick={() => navigate(session ? "dashboard/keys" : "signup")}>
                Get an API key
              </button>
              <button type="button" className="lp-link" onClick={() => navigate("models")}>
                See every model
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <div className="lp-footer-grid">
            <div>
              <span className="lp-brand">
                <span className="lp-brand-mark" aria-hidden="true" />
                RageStar
              </span>
              <p className="lp-small" style={{ marginTop: 12, maxWidth: "28em" }}>
                One endpoint for every frontier model. Routed, streamed and metered.
              </p>
            </div>
            <div>
              <h3>Product</h3>
              <ul>
                <li><button type="button" onClick={() => navigate("models")}>Models</button></li>
                <li><button type="button" onClick={() => navigate("pricing")}>Pricing</button></li>
                <li><button type="button" onClick={() => navigate("status")}>Status</button></li>
              </ul>
            </div>
            <div>
              <h3>Build</h3>
              <ul>
                <li><button type="button" onClick={() => navigate("docs")}>Docs</button></li>
                <li><button type="button" onClick={() => navigate(session ? "dashboard/playground" : "login")}>Playground</button></li>
                <li><button type="button" onClick={() => navigate(session ? "dashboard/keys" : "signup")}>API keys</button></li>
              </ul>
            </div>
            <div>
              <h3>Account</h3>
              <ul>
                <li><button type="button" onClick={() => navigate(session ? "dashboard" : "login")}>{session ? "Console" : "Sign in"}</button></li>
                <li><button type="button" onClick={() => navigate("signup")}>Create workspace</button></li>
                <li><button type="button" onClick={() => navigate("privacy")}>Privacy</button></li>
              </ul>
            </div>
          </div>
          <div className="lp-footer-bottom">
            <span>RageStar</span>
            <span>{API_HOST}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
