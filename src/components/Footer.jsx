import React from "react";

/* v9 footer: hairline rule, mono column heads, one live-status pill. */

const COLS = [
  { h: "Product", links: [["Models", "#/models"], ["Pricing", "#/pricing"], ["Console", "#/console"], ["Status", "#/status"]] },
  { h: "Developers", links: [["Documentation", "#/docs"], ["Quickstart", "#/docs"], ["API reference", "#/docs"]] },
  { h: "Account", links: [["Log-in", "#/login"], ["Sign-up", "#/signup"], ["Reset password", "#/reset"]] },
];

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <a className="brand" href="#/">
              <span className="brand-name">Rage<span className="dim">Star</span></span>
            </a>
            <p className="muted small mt-4" style={{ maxWidth: "34ch", marginTop: 12 }}>
              One OpenAI-compatible endpoint in front of your routed models.
              Keys, routing, token compression and usage all live in your own
              Supabase project.
            </p>
            <p style={{ marginTop: 14 }}>
              <a className="status-pill" href="#/status">
                <span className="dot dot-ok" />Live status
              </a>
            </p>
          </div>
          {COLS.map((c) => (
            <div key={c.h}>
              {/* h3, not h4: the page above ends on h2, so the outline must
                  step down one level, not two */}
              <h3>{c.h}</h3>
              <ul>
                {c.links.map(([label, href]) => (
                  <li key={label}><a href={href}>{label}</a></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="footer-bottom">
          <span className="faint xs mono">RageStar · react + supabase</span>
          <span className="faint xs mono">auth, routing, compression and logs run on your project</span>
        </div>
      </div>
    </footer>
  );
}
