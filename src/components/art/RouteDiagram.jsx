import React from "react";

/* ---------------------------------------------------------------------------
   Request-path schematic — the one drawing that explains the product.

   Real vector geometry on a 640x380 grid. Every node, port and label maps to
   something the gateway actually does: callers on the left, your gateway in
   the middle, the origin API and its keys inside a boundary they never see.
   Motion is one packet per route driven by CSS motion paths (offset-path), so
   the drawing still reads correctly as a single static frame, and stops
   entirely under prefers-reduced-motion.
--------------------------------------------------------------------------- */

const CLIENTS = [
  { label: "curl", y: 74, glyph: "terminal" },
  { label: "openai-sdk", y: 190, glyph: "code" },
  { label: "your app", y: 306, glyph: "app" },
];

const UPSTREAMS = [
  { y: 96, note: "origin 1", tone: "ok" },
  { y: 190, note: "origin 2", tone: "ok" },
  { y: 284, note: "origin 3", tone: "warn" },
];

/* caller → gateway */
const IN_PATHS = [
  "M132 74C188 74 200 190 256 190",
  "M132 190H256",
  "M132 306C188 306 200 190 256 190",
];

/* gateway → origin */
const OUT_PATHS = [
  "M384 190C432 190 444 96 470 96",
  "M384 190H470",
  "M384 190C432 190 444 284 470 284",
];

function ClientGlyph({ kind }) {
  if (kind === "terminal") {
    return (
      <g className="dg-glyph">
        <rect x="0.9" y="1.9" width="14.2" height="12.2" rx="2.4" />
        <path d="M4.3 6.7 6.6 9l-2.3 2.3M8.9 11.3h3.2" />
      </g>
    );
  }
  if (kind === "code") {
    return (
      <g className="dg-glyph">
        <path d="M5.6 3.9 1.5 8l4.1 4.1M10.4 3.9 14.5 8l-4.1 4.1" />
      </g>
    );
  }
  return (
    <g className="dg-glyph">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3.2" />
      <circle cx="8" cy="8" r="2.1" />
    </g>
  );
}

function KeyGlyph() {
  return (
    <g className="dg-glyph">
      <circle cx="4.6" cy="8" r="3.1" />
      <path d="M7.7 8h6.8M12 8v2.6M14.5 8v1.9" />
    </g>
  );
}

function Packet({ d, delay = 0, dur = 2.4, tone = "req", reverse = false }) {
  return (
    <circle
      className={`dg-packet is-${tone}${reverse ? " is-rev" : ""}`}
      r="3.4"
      style={{
        "--dg-path": `path("${d}")`,
        "--dg-delay": `${delay}s`,
        "--dg-dur": `${dur}s`,
      }}
    />
  );
}

export default function RouteDiagram({ host = "api.yourdomain", className = "" }) {
  return (
    <figure className={`dg-figure ${className}`}>
      <div className="dg-frame">
        <div className="dg-frame-top">
          <span className="dg-frame-title">Request path</span>
          <span className="dg-frame-note mono">caller → your gateway → origin</span>
        </div>

        <svg className="dg" viewBox="0 0 640 380" role="img" aria-labelledby="dg-t dg-d">
          <title id="dg-t">How a request travels through your gateway</title>
          <desc id="dg-d">
            Callers such as curl, an OpenAI SDK or your own app send requests to your
            gateway. The gateway forwards them to origin APIs whose base URLs, keys and
            model names stay inside a boundary callers never see.
          </desc>

          <defs>
            <linearGradient id="dg-trunk" x1="120" y1="0" x2="640" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0" className="dg-stop-a" />
              <stop offset="0.52" className="dg-stop-b" />
              <stop offset="1" className="dg-stop-c" />
            </linearGradient>
            <linearGradient id="dg-plate" x1="256" y1="142" x2="384" y2="238" gradientUnits="userSpaceOnUse">
              <stop offset="0" className="dg-plate-a" />
              <stop offset="1" className="dg-plate-b" />
            </linearGradient>
          </defs>

          {/* ---------------------------------------------------------- labels */}
          <text x="24" y="34" className="dg-label">callers</text>
          <text x="256" y="34" className="dg-label">your surface</text>
          <text x="452" y="34" className="dg-label is-locked">sealed · origin side</text>

          {/* ------------------------------------------------------------ wires */}
          <g className="dg-wires">
            {IN_PATHS.map((d, i) => (
              <path key={`in-${i}`} d={d} className="dg-wire" />
            ))}
            {OUT_PATHS.map((d, i) => (
              <path key={`out-${i}`} d={d} className="dg-wire is-origin" />
            ))}
          </g>

          {/* ---------------------------------------------------------- packets */}
          <g className="dg-packets">
            {IN_PATHS.map((d, i) => (
              <Packet key={`pin-${i}`} d={d} delay={i * 0.85} />
            ))}
            {OUT_PATHS.map((d, i) => (
              <Packet key={`pout-${i}`} d={d} delay={i * 0.85 + 1.2} />
            ))}
            <Packet d={OUT_PATHS[1]} delay={2.6} tone="res" reverse />
            <Packet d={IN_PATHS[1]} delay={3.5} tone="res" reverse />
          </g>

          {/* ----------------------------------------------------- caller chips */}
          {CLIENTS.map((c) => (
            <g key={c.label} className="dg-client">
              <rect x="24" y={c.y - 18} width="108" height="36" rx="10" className="dg-chip" />
              <g transform={`translate(38 ${c.y - 8})`}>
                <ClientGlyph kind={c.glyph} />
              </g>
              <text x="62" y={c.y + 4} className="dg-chip-label">
                {c.label}
              </text>
            </g>
          ))}

          {/* --------------------------------------------------------- boundary */}
          <g className="dg-vault">
            <rect x="452" y="48" width="176" height="284" rx="18" className="dg-vault-frame" />
            <path d="M452 190h-12" className="dg-vault-tick" />
          </g>

          {/* -------------------------------------------------------- gateway */}
          <g className="dg-core">
            <rect x="248" y="134" width="144" height="112" rx="22" className="dg-core-halo" />
            <rect x="256" y="142" width="128" height="96" rx="18" className="dg-core-plate" />
            <rect x="256" y="142" width="128" height="96" rx="18" className="dg-core-ring" />
            <g className="dg-mark" transform="translate(306 152)">
              <circle cx="4" cy="14" r="2.7" className="dg-mark-core" />
              <path d="M7.4 14h4.4M12 14 22 6.6M12 14h10M12 14l10 7.4" />
              <circle cx="24.4" cy="6.6" r="2" />
              <circle cx="24.4" cy="14" r="2" />
              <circle cx="24.4" cy="21.4" r="2" />
            </g>
            <text x="320" y="203" textAnchor="middle" className="dg-core-name">
              your gateway
            </text>
            <text x="320" y="221" textAnchor="middle" className="dg-core-host">
              {host}
            </text>
            <circle cx="256" cy="190" r="4" className="dg-port" />
            <circle cx="384" cy="190" r="4" className="dg-port" />
          </g>

          {/* -------------------------------------------------------- origins */}
          {UPSTREAMS.map((u) => (
            <g key={u.note} className="dg-origin">
              <rect x="470" y={u.y - 22} width="140" height="44" rx="12" className="dg-up" />
              <g transform={`translate(484 ${u.y - 8})`}>
                <KeyGlyph />
              </g>
              <text x="506" y={u.y - 2} className="dg-up-mask">
                ●●●●●●●●●●
              </text>
              <text x="506" y={u.y + 12} className="dg-up-note">
                {u.note}
              </text>
              <circle cx="598" cy={u.y} r="3.2" className={`dg-state is-${u.tone}`} />
            </g>
          ))}
        </svg>

        <div className="dg-legend">
          <span className="dg-key">
            <i className="is-req" aria-hidden="true" />
            request
          </span>
          <span className="dg-key">
            <i className="is-res" aria-hidden="true" />
            response
          </span>
          <span className="dg-key">
            <i className="is-sealed" aria-hidden="true" />
            base URL, keys, model names
          </span>
        </div>
      </div>
    </figure>
  );
}
