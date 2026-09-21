/* ==========================================================================
   Orrery — the star and everything in orbit around it
   --------------------------------------------------------------------------
   The whole product in one picture. RageStar is the vermilion star at centre.
   Every published model is a body on an orbit. A request is a ray that leaves
   the star, reaches a body, and comes back.

   EVERY NUMBER HERE IS REAL, in keeping with the rule DESIGN-NOTES.md sets
   and data.js restates: nothing on the marketing pages is fabricated.

     bodies      the published catalog (public_models), via useCatalog
     body size   requests_24h from route_health — busier models are larger
     ring        assigned by traffic rank, busiest innermost, like a real
                 system where the hot path is closest to the core
     ray timing  avg_latency_ms of the body it fires at, so the animation's
                 duration IS that model's latency, not a decoration of it
     ray target  weighted by requests_24h, so the star talks most to the
                 models that are actually talked to most

   Until the gateway answers, the kit's fixture catalog renders with no
   traffic weighting and the ray does not fire. Nothing invented fills the gap.

   The visual language is ukiyo-e: flat vermilion disc, hard-edged bodies, no
   gradient, no glow, no blur. The one wildcard is the orbit stroke's slightly
   irregular dasharray, which makes the ring read as inked rather than plotted.

   Accessibility. The figure has a text alternative summarising what it shows.
   Each body is a focusable, labelled element, so the orrery is browsable by
   keyboard and the readout is reachable without a pointer. Reduced motion
   stops the ray; the drawing is complete without it.
   ========================================================================== */

import { useEffect, useMemo, useRef, useState } from "react";
import { models as fixtureModels } from "../dashboard/data.js";
import { useCatalog } from "../lib/workspace.js";
import { isConfigured } from "../../lib/config.js";
import { routeHealth } from "../../lib/db.js";

const SIZE = 640;
const CX = SIZE / 2;
const CY = SIZE / 2;
const STAR_R = 26;
/* four rings, innermost for the hottest path */
const RINGS = [118, 172, 226, 280];
/* bodies per ring; inner rings hold fewer, like a real system's core */
const CAPACITY = [3, 5, 7, 9];
const MAX_BODIES = CAPACITY.reduce((a, b) => a + b, 0);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Live per-model traffic from the public route_health view, or null. */
function useRouteHealth() {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!isConfigured) return undefined;
    let live = true;
    routeHealth()
      .then((r) => {
        if (live) setRows(Array.isArray(r) ? r : []);
      })
      .catch(() => {
        if (live) setRows(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return rows;
}

/**
 * Lay the catalog out on the rings.
 * Returns bodies with position, radius and the live figures they carry.
 */
function layout(catalog, health) {
  const traffic = new Map();
  for (const r of health ?? []) {
    traffic.set(r.model, {
      requests: num(r.requests_24h),
      latency: num(r.avg_latency_ms) || null,
      success: r.success_rate == null ? null : num(r.success_rate),
    });
  }

  const ranked = catalog
    .map((m) => ({ ...m, live: traffic.get(m.id) ?? null }))
    .sort((a, b) => (b.live?.requests ?? 0) - (a.live?.requests ?? 0))
    .slice(0, MAX_BODIES);

  const maxReq = Math.max(1, ...ranked.map((m) => m.live?.requests ?? 0));
  const anyTraffic = ranked.some((m) => (m.live?.requests ?? 0) > 0);

  const bodies = [];
  let i = 0;
  RINGS.forEach((ringR, ringIndex) => {
    const slots = CAPACITY[ringIndex];
    const onRing = ranked.slice(i, i + slots);
    i += slots;
    /* offset each ring's start so bodies do not line up in a spoke */
    const phase = (ringIndex * Math.PI) / 5 + Math.PI / 7;
    onRing.forEach((m, k) => {
      const angle = phase + (k / slots) * Math.PI * 2;
      const req = m.live?.requests ?? 0;
      /* 4px floor so a quiet model is still a body; sqrt so a hot model does
         not swallow the ring */
      const r = anyTraffic ? 4 + Math.sqrt(req / maxReq) * 9 : 6;
      bodies.push({
        ...m,
        ring: ringIndex,
        x: CX + Math.cos(angle) * ringR,
        y: CY + Math.sin(angle) * ringR,
        r,
        quiet: anyTraffic && req === 0,
      });
    });
  });

  return { bodies, anyTraffic };
}

/** Pick a body to fire at, weighted by live traffic. */
function pickTarget(bodies) {
  const weighted = bodies.filter((b) => (b.live?.requests ?? 0) > 0);
  if (!weighted.length) return null;
  const total = weighted.reduce((a, b) => a + b.live.requests, 0);
  let roll = Math.random() * total;
  for (const b of weighted) {
    roll -= b.live.requests;
    if (roll <= 0) return b;
  }
  return weighted[weighted.length - 1];
}

export default function Orrery({ onFigures }) {
  const catalog = useCatalog();
  const health = useRouteHealth();
  const [hover, setHover] = useState(null);
  const [firing, setFiring] = useState(null); /* { id, ms } */
  const [lit, setLit] = useState(null);
  const reduced = useRef(false);

  const { bodies, anyTraffic } = useMemo(
    () => layout(catalog ?? fixtureModels, health),
    [catalog, health],
  );

  /* report the summary figures up to the hero so they sit under the headline
     and the picture agree on one set of numbers */
  useEffect(() => {
    if (!onFigures) return;
    const live = bodies.filter((b) => b.live);
    const reqs = live.reduce((a, b) => a + (b.live.requests ?? 0), 0);
    const okWeighted = live.reduce(
      (a, b) => a + (b.live.success ?? 0) * (b.live.requests ?? 0),
      0,
    );
    const latWeighted = live.reduce(
      (a, b) => a + (b.live.latency ?? 0) * (b.live.requests ?? 0),
      0,
    );
    onFigures({
      models: (catalog ?? fixtureModels).length,
      connected: reqs > 0 ? okWeighted / reqs : null,
      latency: reqs > 0 ? Math.round(latWeighted / reqs) : null,
      liveCatalog: catalog != null,
    });
  }, [bodies, catalog, onFigures]);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  /* the ray. Fires only when there is real traffic to represent. */
  useEffect(() => {
    if (!anyTraffic || reduced.current) return undefined;
    let alive = true;
    let timer;
    const fire = () => {
      if (!alive) return;
      const target = pickTarget(bodies);
      if (!target) return;
      /* the ray's duration is that model's latency, clamped so a 6s outlier
         does not stall the picture and a 40ms one is still visible */
      const ms = Math.min(2400, Math.max(420, target.live.latency ?? 900));
      setFiring({ id: target.id, ms });
      window.setTimeout(() => {
        if (!alive) return;
        setLit(target.id);
        window.setTimeout(() => alive && setLit(null), 320);
      }, ms * 0.5);
      window.setTimeout(() => alive && setFiring(null), ms);
      timer = window.setTimeout(fire, ms + 700 + Math.random() * 900);
    };
    timer = window.setTimeout(fire, 800);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [bodies, anyTraffic]);

  const hovered = hover ? bodies.find((b) => b.id === hover) : null;
  const firingBody = firing ? bodies.find((b) => b.id === firing.id) : null;

  const summary = anyTraffic
    ? `${bodies.length} models in orbit around RageStar, sized by traffic in the last 24 hours. A ray fires from the star to a model at that model's live latency.`
    : `${bodies.length} models in orbit around RageStar.`;

  return (
    <figure className="lp-orrery" aria-label={summary}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-hidden="true" focusable="false">
        {RINGS.map((r) => (
          <circle key={r} className="lp-orbit" cx={CX} cy={CY} r={r} />
        ))}

        {/* the ray, drawn under the bodies so it lands beneath the target */}
        {firingBody && (
          <line
            className="lp-ray"
            data-firing="true"
            pathLength="1"
            x1={CX}
            y1={CY}
            x2={firingBody.x}
            y2={firingBody.y}
            style={{ "--lp-ray-ms": `${firing.ms}ms` }}
          />
        )}

        <circle className="lp-star-ring" cx={CX} cy={CY} r={STAR_R + 10} />
        <circle className="lp-star" cx={CX} cy={CY} r={STAR_R} />
      </svg>

      {/* Bodies are real buttons positioned over the SVG rather than SVG
          elements, so they are focusable, labelled and hit-testable without
          any SVG accessibility caveats. */}
      <ul className="lp-bodies" aria-label="Models in orbit">
        {bodies.map((b) => {
          const label = b.live
            ? `${b.name}. ${b.live.requests.toLocaleString()} requests in 24 hours${b.live.latency ? `, ${b.live.latency} ms` : ""}.`
            : b.name;
          return (
            <li
              key={b.id}
              className="lp-body-group"
              data-active={hover === b.id}
              data-lit={lit === b.id}
              style={{
                left: `${(b.x / SIZE) * 100}%`,
                top: `${(b.y / SIZE) * 100}%`,
                "--lp-body-r": `${b.r}px`,
              }}
            >
              <button
                type="button"
                className="lp-body-hit"
                aria-label={label}
                onPointerEnter={() => setHover(b.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(b.id)}
                onBlur={() => setHover(null)}
              >
                <span className={`lp-body${b.quiet ? " lp-body--quiet" : ""}`} />
              </button>
            </li>
          );
        })}
      </ul>

      {hovered && (
        <div
          className="lp-readout"
          role="status"
          style={{ left: `${(hovered.x / SIZE) * 100}%`, top: `${(hovered.y / SIZE) * 100}%` }}
        >
          <b>{hovered.name}</b>
          {hovered.live ? (
            <span>
              {hovered.live.requests.toLocaleString()} requests, 24h
              {hovered.live.latency ? ` · ${hovered.live.latency} ms` : ""}
            </span>
          ) : (
            <span>{hovered.provider}</span>
          )}
        </div>
      )}

      <figcaption className="lp-orrery-caption">
        <span>{bodies.length} models in orbit</span>
        <span>{anyTraffic ? "sized by 24h traffic" : catalog == null ? "connecting to the gateway" : "awaiting traffic"}</span>
      </figcaption>
    </figure>
  );
}
