/* ==========================================================================
   status.jsx — the RageStar status page, ported from the RageStar landing kit.
   Live UTC clock + req/s, per-region p50 tiles, 90-day uptime bars per
   component, the incident log, scheduled maintenance and the history card.
   ========================================================================== */

import { useEffect, useState } from "react";
import { PageNav } from "./pages.jsx";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { Reveal, Badge } from "../components/ui.jsx";
import { cn } from "../lib/cn.js";
import { useStatus } from "../lib/workspace.js";

function UptimeRow({ label, days }) {
  const [hovered, setHovered] = useState(null);
  /* Bars come from real health rows only. This component used to mint a 90-day
     history from a seed when it had none, which is the one thing a status page
     must never do. */
  const known = Array.isArray(days) && days.length > 0;
  const up = known ? ((days.filter((d) => d === 0).length / days.length) * 100).toFixed(2) : null;
  return (
    <div className="py-3.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[12.5px] font-medium text-white/85">{label}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-white/65">
          {hovered !== null ? "day −" + (90 - hovered) : known ? `${up}% up` : "not reported"}
        </span>
      </div>
      <div className="mt-2 flex gap-[2px]" onMouseLeave={() => setHovered(null)}>
        {(days ?? []).map((d, i) => (
          <span
            key={i}
            onMouseEnter={() => setHovered(i)}
            className={cn(
              "h-6 flex-1 rounded-[2px] transition-transform duration-150 hover:scale-y-125",
              d === 0 && "bg-brand-lime/75",
              d === 1 && "bg-brand-gold",
              d === 2 && "bg-brand-coral",
              hovered === i && "ring-1 ring-ink-800",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export default function StatusPage({ navigate, session }) {
  const [clock, setClock] = useState(() => new Date());
  const [email, setEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  /* The clock is the only thing on this page that ticks. It used to also
     invent a requests/second figure and jitter every region's p50 on a timer,
     which looked exactly like live telemetry. */
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  /* Real platform health only. There is no fixture fallback any more: when the
     gateway has not answered, the page says so rather than naming components
     and drawing bars it made up. */
  const status = useStatus();
  const rows = status?.components ?? [];
  const healthKnown = status != null;
  const degraded = rows.filter((c) => c.status === "degraded").length;

  return (
    <div className="relative min-h-screen text-white/85">
      <div className="relative z-10">
        <PageNav navigate={navigate} session={session} />

        <section className="mx-auto max-w-5xl px-4 py-14 sm:px-6 md:py-16">
          <Reveal>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Badge tone={degraded ? "coral" : "lime"}>ragestar status</Badge>
                <span className="font-mono text-[11px] tabular-nums tracking-[0.12em] text-white/65">
                  {clock.toUTCString().slice(17, 25)} UTC
                </span>
              </div>
              <div className="flex items-center gap-4">
                {subscribed ? (
                  <span className="rounded-full border border-brand-lime/40 bg-brand-lime/10 px-3.5 py-2 font-mono text-[10px] tracking-[0.16em] text-brand-lime uppercase">
                    ✓ subscribed
                  </span>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (email.includes("@")) setSubscribed(true);
                    }}
                    className="flex overflow-hidden rounded-full border-[1.5px] border-ink-700/60 bg-[#f4f6ee] focus-within:border-brand-ember/70"
                  >
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@ops.team"
                      className="w-36 bg-transparent px-3.5 py-2 font-mono text-[11px] text-white/85 placeholder:text-white/65 focus:outline-none sm:w-44"
                    />
                    <button type="submit" className="bg-ink-800 px-4 font-mono text-[10px] tracking-[0.14em] text-[#e9ece4] uppercase transition-colors hover:bg-brand-ember">
                      watch
                    </button>
                  </form>
                )}
              </div>
            </div>
          </Reveal>

          {/* banner */}
          <Reveal delay={80}>
            <div
              className={cn(
                "mt-8 flex items-center gap-4 rounded-2xl border-[1.5px] px-5 py-5",
                degraded ? "border-brand-gold/60 bg-brand-gold/10" : "border-brand-lime/50 bg-brand-lime/10",
              )}
            >
              <DotmSquare1
                size={26}
                dotSize={4}
                color={degraded ? "#C79A1E" : "#0D7A66"}
                speed={0.8}
                bloom
                className="shrink-0"
                aria-hidden
              />
              <div>
                <p className="font-display text-lg font-bold tracking-tight text-white/85">
                  {!healthKnown
                    ? "Health not reported"
                    : degraded
                      ? "Partial service degradation"
                      : "All systems operational"}
                </p>
                <p className="mt-0.5 text-[13px] text-white/65">
                  {!healthKnown
                    ? "This page shows live model health from the gateway. Nothing has been reported yet."
                    : degraded
                      ? "One or more models are serving below their 24h success-rate SLO."
                      : "Every model is serving traffic within its SLO."}
                </p>
              </div>
            </div>
          </Reveal>

          {/* components + 90d */}
          <Reveal delay={200}>
            <div className="mt-8 overflow-hidden rounded-3xl border-[1.5px] border-ink-700/50 bg-[#f4f6ee]">
              <header className="flex items-center justify-between border-b border-ink-700/40 px-5 py-4">
                <h2 className="font-display text-[15px] font-bold tracking-tight text-white/85">
                  Live health · last 90 days
                </h2>
                <div className="flex items-center gap-4 font-mono text-[9.5px] tracking-[0.12em] text-white/65 uppercase">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-brand-lime/75" /> ok</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-brand-gold" /> degraded</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-brand-coral" /> outage</span>
                </div>
              </header>
              <div className="divide-y divide-ink-700/30 px-5 py-2">
                {/* Live: one real 90-day strip for the platform, then a row per
                    model carrying its actual 24h success rate. Bars are
                    platform-wide because gateway_daily_health is not per-model
                    — repeating one strip per row would imply data we lack. */}
                {status ? (
                  <>
                    <UptimeRow label="All endpoints" days={status.days} />
                    {status.components.map((c) => (
                      <div key={c.name} className="grid items-center gap-x-6 gap-y-2 py-4 sm:grid-cols-[1.1fr_2fr]">
                        <div>
                          <p className="flex items-center gap-2.5 text-[13.5px] font-medium text-white/85">
                            <span className={cn("h-2 w-2 rounded-full", c.status === "operational" ? "bg-brand-lime" : "animate-pulse bg-brand-gold")} />
                            {c.name}
                          </p>
                          <p className="mt-0.5 pl-[18px] font-mono text-[10px] tracking-[0.1em] text-white/65">
                            {c.note} · {c.status}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-700/20">
                            <span
                              className={cn("block h-full rounded-full", c.status === "operational" ? "bg-brand-lime/75" : "bg-brand-gold")}
                              style={{ width: `${Math.min(100, Math.max(0, c.rate ?? 0))}%` }}
                            />
                          </span>
                          <span className="w-16 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-white/65">
                            {c.uptime}
                          </span>
                        </div>
                      </div>
                    ))}
                  </>
                ) : (
                  <p className="py-10 text-center text-[13px] text-white/65">
                    {healthKnown
                      ? "No model has served traffic in the last 24 hours."
                      : "Waiting for platform health. Nothing is shown here until the gateway reports it."}
                  </p>
                )}
              </div>
            </div>
          </Reveal>

          {/* maintenance + meta */}
          <div className="mt-14 grid gap-4">
            <Reveal delay={80}>
              <div className="flex flex-col justify-between rounded-2xl border-[1.5px] border-ink-700/50 bg-ink-800 p-6">
                <div>
                  <p className="font-mono text-[10px] tracking-[0.2em] text-[#e9ece4]/60 uppercase">history &amp; feeds</p>
                  <p className="font-display mt-3 text-lg font-bold tracking-tight text-[#e9ece4]">
                    Post-mortems &amp; incident history
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-[#e9ece4]/60">
                    A written post-mortem is published for every SEV1 and SEV2 within 5 business days.
                  </p>
                </div>
                <div className="mt-5 flex gap-2.5">
                  <button onClick={() => navigate("docs")} className="rounded-full border border-[#e9ece4]/30 px-4 py-2.5 font-mono text-[10px] tracking-[0.16em] text-[#e9ece4]/85 uppercase hover:border-[#e9ece4]/60">
                    api docs
                  </button>
                  <button onClick={() => navigate("")} className="rounded-full border border-[#e9ece4]/30 px-4 py-2.5 font-mono text-[10px] tracking-[0.16em] text-[#e9ece4]/85 uppercase hover:border-[#e9ece4]/60">
                    back to site
                  </button>
                </div>
              </div>
            </Reveal>
          </div>

          <p className="mt-10 text-center font-mono text-[10px] tracking-[0.2em] text-white/65 uppercase">
            status.ragestar.ai · subscribe for email, slack &amp; pagerduty hooks
          </p>
        </section>
      </div>
    </div>
  );
}
