/* ==========================================================================
   pricing.jsx — the RageStar pricing page, ported from the RageStar landing kit.
   Access is free and issued by admins, so this page carries the plan cards,
   the model capability table, the plan comparison matrix, the access FAQs and
   the CTA band — with no money figures anywhere on it.
   ========================================================================== */

import { useState } from "react";
import { PageNav } from "./pages.jsx";
import { Badge, Reveal } from "../components/ui.jsx";
import { cn } from "../lib/cn.js";

const tiers = [
  {
    name: "Developer",
    tagline: "Free access for prototypes and side projects",
    features: ["Included starting credit", "60 requests / minute", "Every text, vision and code model", "Community support", "Standard regions"],
  },
  {
    name: "Scale",
    tagline: "For products with real traffic and SLAs",
    featured: true,
    features: ["Higher-volume token throughput", "2,000 requests / minute", "Failover routing + priority capacity", "Zero-retention mode", "Fine-tuning · 40 GPU hours", "4h support response"],
  },
  {
    name: "Enterprise",
    tagline: "Dedicated capacity and compliance",
    features: ["Dedicated GPU clusters", "99.99% uptime SLA", "Regional pinning & BYOK", "SSO / SCIM, audit logs", "Private deployment option", "Named solutions architect"],
  },
];

const matrix = [
  { feature: "Rate limit", dev: "60 rpm", scale: "2,000 rpm", ent: "Custom" },
  { feature: "Failover routing", dev: "—", scale: "✓", ent: "✓" },
  { feature: "Zero-retention mode", dev: "✓", scale: "✓", ent: "✓ + BYOK" },
  { feature: "Fine-tuning", dev: "—", scale: "40 GPU-hrs", ent: "Unlimited" },
  { feature: "Dedicated capacity", dev: "—", scale: "—", ent: "✓" },
  { feature: "SSO / SCIM", dev: "—", scale: "—", ent: "✓" },
  { feature: "Uptime SLA", dev: "Best effort", scale: "99.9%", ent: "99.99%" },
  { feature: "Support", dev: "Community", scale: "4h response", ent: "Named architect" },
];

const pricingFaqs = [
  { q: "How do I get access?", a: "Create a new Google account and hand the address to an admin. The admin attaches the subscription to that account and activates whichever plan you pick below — nothing is charged at any point." },
  { q: "What do the plans actually change?", a: "Rate limits, capacity and support. Developer runs at 60 requests per minute, Scale raises that to 2,000 with failover routing and priority capacity, and Enterprise adds dedicated GPU clusters and a named solutions architect." },
  { q: "Do I need to give payment details?", a: "No. No card, no contract and no details of any kind. Access is issued by an admin, so picking a plan is simply choosing a level of permission on your account." },
  { q: "What happens if I reach a limit?", a: "Usage is metered so the gateway can report it and keep rate limits fair, and it is visible in the console. If a limit gets in your way, ask an admin — they can raise it on your account." },
];

export default function PricingPage({ navigate, session }) {
  const [open, setOpen] = useState(0);

  return (
    <div className="relative min-h-screen text-white/85">
      <div className="relative z-10">
        <PageNav navigate={navigate} session={session} />

        <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6 md:py-20">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <Reveal><Badge tone="ember">pricing</Badge></Reveal>
              <Reveal delay={70}>
                <h1 className="font-display mt-5 max-w-2xl text-[2.4rem] leading-[1.02] font-bold tracking-[-0.03em] text-white/85 sm:text-5xl">
                  Free access.
                  <br />
                  <span className="text-brand-ember">Nothing to pay.</span>
                </h1>
              </Reveal>
              <Reveal delay={140}>
                <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-white/65">
                  No seat minimums, no commit requirements, no card details. Access is issued by an
                  admin, so every model the gateway routes to is available to your account the moment
                  they activate your plan.
                </p>
              </Reveal>
            </div>
          </div>

          {/* Said plainly, and above the plans rather than behind the signup
              button: nobody is charged here, so a visitor should not have to
              reach checkout to discover that. */}
          <Reveal delay={60}>
            <div className="mt-12 rounded-2xl border-[1.5px] border-brand-ember/40 bg-brand-ember/[0.07] p-6 sm:p-7">
              <span className="font-mono text-[10px] tracking-[0.18em] text-brand-ember uppercase">
                no payment needed
              </span>
              <p className="font-display mt-2 text-xl font-bold tracking-tight text-white/85">
                No real money is involved.
              </p>
              <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-white/70">
                Subscribing never charges a card. Create a new Google account and hand it to an
                admin — the admin creates the subscription on that account and activates whichever
                plan you pick below.
              </p>
              <p className="mt-3 text-[12.5px] text-white/55">
                So Developer, Scale and Enterprise all cost nothing here, and none of them ask for
                payment details. Pick a plan, then send an admin the Google address to attach it to.
              </p>
            </div>
          </Reveal>

          {/* plans */}
          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {tiers.map((t, i) => (
              <Reveal key={t.name} delay={i * 90} className="h-full">
                <div
                  className={cn(
                    "relative flex h-full flex-col rounded-3xl p-7 transition-transform duration-500 hover:-translate-y-1",
                    t.featured ? "pr-glass-strong pr-glow-ember" : "border-[1.5px] border-ink-700/50 bg-[#f4f6ee] hover:border-ink-700",
                  )}
                >
                  {t.featured && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[#101814] px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-[#e9ece4] uppercase">
                      most popular
                    </span>
                  )}
                  <h3 className="font-display text-lg font-bold tracking-tight text-white/85">{t.name}</h3>
                  <p className="mt-2 text-[13px] text-white/65">{t.tagline}</p>
                  <ul className="mt-7 space-y-3 border-t border-ink-700/40 pt-6">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-start gap-3 text-[13.5px] text-white/85">
                        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-brand-ember" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => navigate(session ? "dashboard" : "signup")}
                    className={cn(
                      "mt-8 inline-flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-medium transition-all duration-300",
                      t.featured
                        ? "bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 text-[#e9ece4] hover:shadow-[6px_6px_0_0_#101814]"
                        : "border-[1.5px] border-ink-700/60 text-white/85 hover:border-ink-800 hover:bg-ink-800/70",
                    )}
                  >
                    {t.name === "Enterprise" ? "Talk to engineering" : "Start free"}
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </Reveal>
            ))}
          </div>

          {/* comparison matrix */}
          <div className="mt-20">
            <Reveal>
              <h2 className="font-display text-2xl font-bold tracking-tight text-white/85 sm:text-3xl">Plans, side by side.</h2>
            </Reveal>
            <Reveal delay={120}>
              <div className="mt-6 overflow-hidden rounded-3xl border-[1.5px] border-ink-700/50 bg-[#f4f6ee]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse">
                    <thead>
                      <tr className="border-b-[1.5px] border-ink-700/50 bg-ink-800/60">
                        <th className="px-5 py-3.5 text-left font-mono text-[10px] font-normal tracking-[0.16em] text-white/65 uppercase">Capability</th>
                        {["Developer", "Scale", "Enterprise"].map((p) => (
                          <th key={p} className={cn("px-5 py-3.5 text-right font-display text-[13px] font-bold tracking-tight", p === "Scale" ? "text-brand-ember" : "text-white/85")}>
                            {p}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrix.map((r) => (
                        <tr key={r.feature} className="border-b border-ink-700/30 transition-colors last:border-0 hover:bg-brand-ember/5">
                          <td className="px-5 py-3 text-[13px] text-white/85">{r.feature}</td>
                          <td className="px-5 py-3 text-right font-mono text-[12px] text-white/65">{r.dev}</td>
                          <td className="px-5 py-3 text-right font-mono text-[12px] text-white/85">{r.scale}</td>
                          <td className="px-5 py-3 text-right font-mono text-[12px] text-white/65">{r.ent}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Reveal>
          </div>

          {/* faqs */}
          <div className="mt-20 grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <Reveal>
              <Badge tone="coral">access questions</Badge>
              <h2 className="font-display mt-4 text-2xl font-bold tracking-tight text-white/85 sm:text-3xl">
                Before you request access.
              </h2>
              <p className="mt-4 text-[14px] leading-relaxed text-white/65">
                Anything else? Ask an admin — they answer within one business day.
              </p>
            </Reveal>
            <div className="divide-y divide-ink-700/40 border-y-[1.5px] border-ink-700/50">
              {pricingFaqs.map((f, i) => {
                const isOpen = open === i;
                return (
                  <div key={f.q}>
                    <button onClick={() => setOpen(isOpen ? null : i)} className="group flex w-full items-center justify-between gap-6 py-5 text-left" aria-expanded={isOpen}>
                      <span className={cn("font-display text-[15.5px] font-semibold transition-colors", isOpen ? "text-brand-ember" : "text-white/85")}>{f.q}</span>
                      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-all duration-300", isOpen ? "rotate-45 border-brand-ember/50 bg-brand-ember/10 text-brand-ember" : "border-ink-700/50 text-white/65")}>
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                        </svg>
                      </span>
                    </button>
                    <div className={cn("grid overflow-hidden pr-10 transition-all duration-500 ease-out", isOpen ? "grid-rows-[1fr] pb-6 opacity-100" : "grid-rows-[0fr] opacity-0")}>
                      <p className="min-h-0 text-[14px] leading-relaxed text-white/65">{f.a}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* cta band */}
          <Reveal>
            <div className="relative mt-20 overflow-hidden rounded-[32px] border-[1.5px] border-ink-800 bg-ink-800 p-8 sm:p-12">
              <div className="pointer-events-none absolute -top-20 -left-14 h-56 w-56 rounded-full bg-brand-ember/25 blur-[80px]" />
              <div className="relative flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
                <div>
                  <p className="font-mono text-[10.5px] tracking-[0.26em] text-[#e9ece4]/60 uppercase">start free</p>
                  <h2 className="font-display mt-3 text-3xl font-bold tracking-tight text-[#e9ece4] sm:text-4xl">
                    Free access. Two-minute setup.
                  </h2>
                  <p className="mt-3 max-w-lg text-[14px] leading-relaxed text-[#e9ece4]/65">
                    No card required. An admin switches your plan on once you send them the address.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => navigate(session ? "dashboard" : "signup")}
                    className="rounded-full bg-[#e9ece4] px-7 py-3.5 text-[13.5px] font-medium text-white/85 transition-transform hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_rgba(233,236,228,0.35)]"
                  >
                    Create workspace
                  </button>
                  <button
                    onClick={() => navigate("models")}
                    className="rounded-full border border-[#e9ece4]/30 px-7 py-3.5 text-[13.5px] text-[#e9ece4]/85 transition-colors hover:border-[#e9ece4]/60"
                  >
                    Compare models
                  </button>
                </div>
              </div>
            </div>
          </Reveal>
        </section>
      </div>
    </div>
  );
}
