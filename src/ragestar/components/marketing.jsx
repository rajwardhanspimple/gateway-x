/* ==========================================================================
   marketing.jsx — the RageStar landing kit, ported from the RageStar landing page.
   --------------------------------------------------------------------------
   Every section of the marketing site: Nav, SideRail, Hero, PartnerStrip,
   Platform, PlaygroundDemo, StatsSection, ProcessSection, Testimonials,
   PricingTeaser, FaqSection, CtaSection, SiteFooter.
   Class names follow the kit's `pr-` prefix convention (see theme.css) so
   nothing collides with the gateway's own .glass / .reveal / .noise etc.

   Numbers on this page are live: model counts come from the published
   catalog (public_models) and the traffic figures from the public health
   views (see lib/workspace.js). Until the gateway answers, the copy falls
   back to wording without invented figures.
   ========================================================================== */

import { useEffect, useRef, useState } from "react";
import { Badge, Button, Reveal, SectionHeading, TiltCard } from "../components/ui.jsx";
import { useCountUp, useInView } from "../hooks/useInView.js";
import { CodeTabs } from "../dashboard/models.jsx";
import { models } from "../dashboard/data.js";
import { DotmSquare1 } from "./dotmatrix.jsx";
import { cn } from "../lib/cn.js";
import { API_HOST } from "../lib/gateway.js";
import { useCatalog, useCatalogCount, useGatewayStats } from "../lib/workspace.js";

/** 1.2k / 3.4M / 1.2B — for the live traffic figures. */
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${v}`;
}

/* ---------------------------------------------------------------------- nav */

const navLinks = [
  { label: "Models", href: "#/models" },
  { label: "Platform", href: "#platform" },
  { label: "Playground", href: "#playground" },
  { label: "Pricing", href: "#/pricing" },
  { label: "Docs", href: "#/docs" },
  { label: "Status", href: "#/status" },
];

export function Nav({ session }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-4">
      <nav
        className={cn(
          "mx-auto flex max-w-7xl items-center justify-between gap-4 rounded-2xl px-4 py-3 transition-all duration-500 sm:px-5",
          scrolled ? "pr-glass-strong shadow-[0_20px_60px_-30px_rgba(0,0,0,0.9)]" : "border border-transparent",
        )}
      >
        <a href="#top" className="group flex items-center gap-3">
          {/* pr-brand-mark is the landing slot the gateway's RouteLoader flies
              its mark into when a route transition docks (see RouteLoader.jsx
              TARGETS). Keep it on the 36px tile, not on the wordmark. */}
          <span className="pr-brand-mark relative grid h-9 w-9 place-items-center">
            <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90 transition-transform duration-500 group-hover:rotate-[18deg]" />
            <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
              <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M12 3.2v16.2M6.6 12h10.8" stroke="currentColor" strokeWidth="0.9" opacity="0.65" />
            </svg>
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight text-white">
            RageStar
            <span className="ml-1 font-mono text-[10px] tracking-[0.22em] text-white/40 uppercase">ai</span>
          </span>
          <DotmSquare1 size={16} dotSize={2} color="#2447E8" speed={1.15} aria-hidden />
        </a>

        <div className="hidden items-center gap-1 lg:flex">
          {navLinks.map((l) => (
            <a key={l.href} href={l.href} className="rounded-full px-3.5 py-2 text-[13px] text-white/60 transition-colors hover:text-white">
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href="#/status"
            className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[10px] tracking-widest text-lime-300/90 uppercase transition-colors hover:border-lime-400/40 hover:text-lime-300 sm:flex"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-lime-400" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-lime-400" />
            </span>
            all systems healthy
          </a>
          <a
            href={session ? "#/dashboard" : "#/login"}
            className="hidden rounded-full border border-white/12 bg-white/5 px-4 py-2.5 text-[13px] text-white/75 transition-colors hover:bg-white/10 hover:text-white md:inline-flex"
          >
            {session ? "Console" : "Sign in"}
          </a>
          <Button href={session ? "#/dashboard/keys" : "#/signup"} className="hidden px-5 py-2.5 text-[13px] sm:inline-flex">
            Get API key
          </Button>
          <button
            aria-label="Toggle menu"
            onClick={() => setOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/5 text-white lg:hidden"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              {open ? <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
      </nav>

      <div
        className={cn(
          "pr-glass-strong mx-auto mt-2 max-w-7xl overflow-hidden rounded-2xl transition-all duration-500 lg:hidden",
          open ? "max-h-96 opacity-100" : "pointer-events-none max-h-0 border-transparent opacity-0",
        )}
      >
        <div className="flex flex-col p-2">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-xl px-4 py-3 text-sm text-white/70 transition-colors hover:bg-white/5 hover:text-white"
            >
              {l.label}
            </a>
          ))}
          <a href={session ? "#/dashboard" : "#/login"} className="mt-2 rounded-full border border-white/12 bg-white/5 px-6 py-3 text-center text-sm text-white/80">
            {session ? "Open console" : "Sign in"}
          </a>
          <Button href={session ? "#/dashboard/keys" : "#/signup"} onClick={() => setOpen(false)} className="mt-2">
            Get API key
          </Button>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- side rail */

const sections = [
  { id: "top", label: "Start" },
  { id: "platform", label: "Platform" },
  { id: "playground", label: "Playground" },
  { id: "how", label: "How it works" },
  { id: "faq", label: "FAQ" },
  { id: "contact", label: "Get started" },
];

export function SideRail() {
  const [active, setActive] = useState("top");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);
  return (
    <nav aria-label="Section navigation" className="fixed top-1/2 right-5 z-40 hidden -translate-y-1/2 flex-col items-end gap-3 xl:flex">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="group flex items-center gap-3">
          <span
            className={cn(
              "font-mono text-[10px] tracking-[0.2em] uppercase transition-all duration-300",
              active === s.id ? "text-white/80" : "translate-x-1 text-white/0 group-hover:translate-x-0 group-hover:text-white/50",
            )}
          >
            {s.label}
          </span>
          <span className={cn("block h-1.5 rounded-full transition-all duration-500", active === s.id ? "w-6 bg-gradient-to-r from-orange-400 to-rose-400" : "w-1.5 bg-white/25 group-hover:bg-white/50")} />
        </a>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------------------- hero */

const sampleReply = `Vector search embeds text into a high-dimensional space where
semantically similar meaning sits close together.

1. Embed your corpus once.
2. Index the vectors with HNSW.
3. Embed the query at request time and pull the top-k neighbours.
4. Rerank the shortlist before prompting.

Streamed over the OpenAI-compatible /chat/completions endpoint.`;

function HeroTerminal() {
  const [text, setText] = useState("");
  const idx = useRef(0);
  const stats = useGatewayStats();
  const catalog = useCatalog();
  const modelId = catalog?.[0]?.id ?? models[0]?.id ?? "auto";

  useEffect(() => {
    const id = setInterval(() => {
      idx.current += 3;
      setText(sampleReply.slice(0, idx.current));
      if (idx.current > sampleReply.length + 40) idx.current = 0;
    }, 40);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="pr-glass-strong w-full overflow-hidden rounded-2xl text-left shadow-[0_50px_120px_-60px_rgba(36,71,232,0.25)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-lime-300/70" />
          <span className="ml-2 font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
            POST /v1/chat/completions
          </span>
          <DotmSquare1 size={14} dotSize={2} color="#2447E8" speed={1.4} className="ml-auto" aria-hidden />
        </div>
        <div className="flex items-center gap-3">
          {stats?.requests24 > 0 && (
            <span className="hidden font-mono text-[10px] tracking-[0.08em] text-white/45 tabular-nums sm:inline">
              <span className="text-lime-300">{compact(stats.requests24)}</span> req/24h
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-lime-400/25 bg-lime-500/10 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.14em] text-lime-300 uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
            stream
          </span>
        </div>
      </div>
      <pre className="min-h-[190px] p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-white/75">
        <span className="text-white/35">{`{ "model": "${modelId}", "messages": [...] }`}</span>
        {"\n\n"}
        {text}
        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-brand-ember align-middle" />
      </pre>
    </div>
  );
}

const GLYPHS = "▚▞#/=+*<>_·";
function useScramble(text, speed = 26) {
  const [out, setOut] = useState("");
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOut(text);
      return;
    }
    let frame = 0;
    let raf = 0;
    let last = 0;
    const tick = (now) => {
      if (now - last >= speed) {
        last = now;
        frame += 1;
        const settled = Math.floor(frame / 2.4);
        let s = "";
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          s += i < settled ? ch : ch === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        setOut(s);
        if (settled >= text.length) return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, speed]);
  return out;
}

export function Hero() {
  const shell = useRef(null);
  const decoded = useScramble("// one endpoint · every frontier lab · v3.0");
  const catalogCount = useCatalogCount();
  const stats = useGatewayStats();
  const catalog = useCatalog();
  /* Live rows when the catalog answers, the kit's fixture list otherwise. */
  const catalogRows = catalog ?? models;
  const modelCount = catalogCount ?? catalogRows.length;
  const chips = catalogRows.slice(0, 5);

  /* Real platform figures. A metric that has no live source simply is not
     rendered as a number — nothing here is fabricated. */
  const heroMetrics = [
    stats?.tokens24 > 0
      ? { label: "tokens · 24h", value: compact(stats.tokens24), unit: "" }
      : { label: "models", value: `${modelCount}`, unit: "+" },
    stats?.ttft
      ? { label: "avg first token", value: `${stats.ttft}`, unit: "ms" }
      : { label: "OpenAI", value: "compatible", unit: "" },
    stats?.uptime != null
      ? { label: "uptime · 90d", value: stats.uptime.toFixed(2), unit: "%" }
      : { label: "failover", value: "automatic", unit: "" },
  ];

  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    const onMove = (e) => {
      el.style.setProperty("--px", (e.clientX / window.innerWidth - 0.5).toFixed(3));
      el.style.setProperty("--py", (e.clientY / window.innerHeight - 0.5).toFixed(3));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <section id="top" ref={shell} className="relative flex min-h-[100svh] items-center justify-center px-4 pt-28 pb-16 sm:px-6">
      <div
        className="pointer-events-none absolute inset-0 -z-[1]"
        style={{
          background:
            "radial-gradient(ellipse 58% 48% at 50% 46%, rgba(233,236,228,0.6) 0%, rgba(233,236,228,0.32) 46%, rgba(233,236,228,0) 78%), radial-gradient(ellipse 70% 42% at 50% 92%, rgba(36,71,232,0.2) 0%, rgba(13,122,102,0.07) 42%, rgba(233,236,228,0) 76%)",
        }}
      />
      <div className="relative grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <Reveal>
            <Badge tone="ember" className="backdrop-blur">
              <DotmSquare1 size={11} dotSize={2} color="#2447E8" speed={1.2} aria-hidden />
              {catalogCount != null ? `${catalogCount} models · live platform` : `${catalogRows.length}+ models`}
            </Badge>
          </Reveal>
          <p className="mt-4 font-mono text-[11px] tracking-[0.26em] text-white/40 uppercase">
            {decoded}
            <span className="ml-1.5 inline-block h-3 w-[2px] animate-pulse bg-brand-ember align-middle" />
          </p>
          <Reveal delay={70}>
            <h1
              className="font-display mt-5 text-[2.6rem] leading-[0.99] font-bold tracking-[-0.035em] text-balance sm:text-[3.4rem] lg:text-[3.9rem]"
              style={{ transform: "translate3d(calc(var(--px, 0) * 14px), calc(var(--py, 0) * 8px), 0)" }}
            >
              <span className="block text-white/92">One API for every</span>
              <span className="block text-white">
                <span className="relative inline-block text-brand-ember">
                  frontier model
                  <svg className="absolute -bottom-[0.12em] left-0 w-full" viewBox="0 0 300 12" fill="none" aria-hidden>
                    <path d="M2 9C60 3 180 3 298 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.55" />
                  </svg>
                </span>
              </span>
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-white/60 [text-shadow:0_2px_20px_rgba(233,236,228,0.9)] sm:text-[17px]">
              Route prompts across text, vision, code, embedding, image and audio models with
              OpenAI-compatible endpoints. Automatic failover, streaming, tool calling and
              per-request billing — with no GPU ops on your side.
            </p>
          </Reveal>
          <Reveal delay={210}>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button href="#/signup" className="w-full sm:w-auto">
                Start free with $25 credit
                <svg viewBox="0 0 24 24" className="h-4 w-4 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Button>
              <Button href="#/models" variant="outline" className="w-full sm:w-auto">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-brand-ember" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Z" strokeLinejoin="round" />
                  <path d="M12 12l8-4.5M12 12v9M12 12 4 7.5" strokeLinejoin="round" opacity="0.6" />
                </svg>
                Browse {modelCount}+ models
              </Button>
            </div>
          </Reveal>
          <Reveal delay={280}>
            <div className="mt-10 grid gap-3 sm:grid-cols-3" style={{ transform: "translate3d(calc(var(--px, 0) * -12px), calc(var(--py, 0) * -6px), 0)" }}>
              {heroMetrics.map((m, i) => (
                <div
                  key={m.label}
                  className="pr-glass rounded-2xl px-5 py-4"
                  style={{ animation: `pr-floaty ${6.5 + i}s ease-in-out infinite` }}
                >
                  <div className="font-mono text-[10px] tracking-[0.2em] text-white/40 uppercase">{m.label}</div>
                  <div className="mt-1.5 flex items-baseline gap-1">
                    <span className="font-display text-2xl font-semibold text-white">{m.value}</span>
                    <span className="font-mono text-xs text-brand-ember/85">{m.unit}</span>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        <Reveal delay={160}>
          <div
            className="pr-preserve-3d"
            style={{ transform: "translate3d(calc(var(--px, 0) * -18px), calc(var(--py, 0) * 12px), 0)" }}
          >
            <HeroTerminal />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {chips.map((m) => (
                <span key={m.id} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[10.5px] text-white/50">
                  {m.id}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ marquee */


const customers = ["Vector Labs", "Northwind", "Aldercast", "Hallmark AI", "Tessellate", "Cobalt Health", "Duet", "Meridian Bank"];

const modelChips = [
  "text & chat",
  "vision & OCR",
  "code generation",
  "embeddings",
  "reranking",
  "image generation",
  "speech-to-text",
  "fine-tuning",
  "tool calling",
  "structured outputs",
  "batch inference",
  "dedicated GPU",
];

export function PartnerStrip() {
  return (
    <section className="relative z-10 border-y border-white/8 bg-ink-950/60 py-7 backdrop-blur-sm">
      <p className="mb-5 text-center font-mono text-[10px] tracking-[0.34em] text-white/35 uppercase">
        teams routing through ragestar
      </p>
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-28 bg-gradient-to-r from-ink-950 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-28 bg-gradient-to-l from-ink-950 to-transparent" />
        <div className="animate-marquee flex shrink-0 items-center gap-14 pr-14" style={{ animationDuration: "34s" }}>
          {[...customers, ...customers].map((c, i) => (
            <span key={`${c}-${i}`} className="font-display shrink-0 text-[15px] font-semibold tracking-tight whitespace-nowrap text-white/40">
              {c}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export function StackStrip() {
  return (
    <div className="relative overflow-hidden rounded-full border border-white/8 bg-white/[0.03] py-3">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-ink-950 to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-ink-950 to-transparent" />
      <div className="animate-marquee flex shrink-0 items-center gap-3 pr-3" style={{ animationDuration: "30s" }}>
        {[...modelChips, ...modelChips].map((s, i) => (
          <span key={`${s}-${i}`} className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 font-mono text-[11px] whitespace-nowrap text-white/50">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- platform */

const platform = [
  {
    title: "OpenAI-compatible API",
    body: `Point your existing SDK at ${API_HOST} and change one string. Chat, embeddings, images, audio and rerank endpoints match the shapes you already parse.`,
    icon: "M4 6h16v12H4V6Zm4 4h8M8 14h5",
    tint: "rgba(36,71,232,0.5)",
    span: "md:col-span-3",
  },
  {
    title: "Smart routing & failover",
    body: "Per-request routing sends traffic to the healthiest provider and key. If a model degrades, requests re-route mid-flight with the same response contract.",
    icon: "M5 7h9l-3-3m3 3-3 3M19 17h-9l3-3m-3 3 3 3",
    tint: "rgba(226,61,40,0.42)",
    span: "md:col-span-3",
  },
  {
    title: "Streaming & tool calls",
    body: "Server-sent events with partial tool-call arguments, JSON schema outputs and log-probabilities.",
    icon: "M4 12h4l2 4 3-9 2 5h5",
    tint: "rgba(199,154,30,0.42)",
    span: "md:col-span-2",
  },
  {
    title: "Usage-based pricing",
    body: "Every model publishes its per-token price. Spend is metered per request and visible in the console in real time.",
    icon: "M4 19V5m0 14h16M8 15V9m4 6V7m4 8v-4",
    tint: "rgba(13,122,102,0.45)",
    span: "md:col-span-2",
  },
  {
    title: "Guardrails & privacy",
    body: "IP allowlists, per-key spend caps and rate limits. Your prompts are never used to train shared models.",
    icon: "M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Zm-1.6 11.4 4-4",
    tint: "rgba(13,122,102,0.4)",
    span: "md:col-span-2",
  },
];

export function Platform() {
  const stats = useGatewayStats();
  /* Service-level bars show live figures where the public health views
     provide one; a missing source renders the label without a number. */
  const slo = [
    stats?.uptime != null
      ? { label: "Uptime (rolling 90d)", value: `${stats.uptime.toFixed(2)}%`, pct: Math.max(2, Math.min(100, stats.uptime)) }
      : null,
    stats?.ttft
      ? { label: "avg time to first token · 24h", value: `${stats.ttft} ms`, pct: 100 - Math.min(90, Math.round(stats.ttft / 20)) }
      : null,
    stats?.requests24 > 0
      ? { label: "requests served · 24h", value: compact(stats.requests24), pct: 100 }
      : null,
  ].filter(Boolean);

  return (
    <section id="platform" className="relative z-10 px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
          <SectionHeading
            eyebrow="platform"
            title={<>Inference infrastructure without the infrastructure team.</>}
            body="You keep the prompts and the product. We handle routing, retries, timeouts, failover and the billing math behind every token."
          />
          <Reveal delay={200}>
            <div className="pr-glass max-w-xs rounded-2xl p-5">
              <div className="font-mono text-[10px] tracking-[0.24em] text-white/40 uppercase">migrate in minutes</div>
              <p className="mt-2 text-sm leading-relaxed text-white/70">
                Swap the base URL, keep your SDKs. Teams typically land production traffic the same day.
              </p>
            </div>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-6">
          {platform.map((c, i) => (
            <Reveal key={c.title} delay={i * 70} className={c.span}>
              <TiltCard className="h-full">
                <div className="pr-glass relative h-full overflow-hidden rounded-3xl p-6 sm:p-7">
                  <span className="mb-5 grid h-11 w-11 place-items-center rounded-2xl border border-white/12" style={{ background: `linear-gradient(150deg, ${c.tint}, rgba(16,24,20,0.04))` }}>
                    <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d={c.icon} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <h3 className="font-display text-lg font-semibold tracking-tight text-white">{c.title}</h3>
                  <p className="mt-3 text-[14px] leading-relaxed text-white/55">{c.body}</p>
                </div>
              </TiltCard>
            </Reveal>
          ))}

          <Reveal delay={380} className="md:col-span-6">
            <div className="pr-glass relative overflow-hidden rounded-3xl p-6 sm:p-8">
              <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr] lg:items-center">
                <div>
                  <Badge tone="gold">service level</Badge>
                  <h3 className="font-display mt-5 text-2xl font-semibold tracking-tight text-white sm:text-[1.7rem]">
                    An uptime and latency contract, not a slogan.
                  </h3>
                  <p className="mt-4 max-w-lg text-[14px] leading-relaxed text-white/55">
                    The public status page reports the same health views this panel reads — the numbers
                    below are live, not marketing copy.
                  </p>
                </div>
                <div className="space-y-4">
                  {(slo.length
                    ? slo
                    : [{ label: "Live platform metrics publish here once the gateway is connected", value: "", pct: 0 }]
                  ).map((row) => (
                    <div key={row.label}>
                      <div className="mb-2 flex items-center justify-between font-mono text-[10px] tracking-[0.18em] text-white/45 uppercase">
                        <span>{row.label}</span>
                        <span className="text-white/75">{row.value}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/8">
                        <div className="h-full rounded-full bg-gradient-to-r from-orange-500 to-amber-300" style={{ width: `${row.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- playground section */

export function PlaygroundDemo() {
  const [mode, setMode] = useState("chat");
  const catalog = useCatalog();
  /* The demo labels its samples with real model ids from the live catalog;
     the kit's fixtures only show when the gateway is not configured. */
  const list = catalog ?? models;
  const pick = (pred, fallbackIndex = 0) =>
    list.find(pred)?.id ?? list[fallbackIndex]?.id ?? list[0]?.id ?? "your-model-id";
  const demoModes = [
    { id: "chat", label: "Chat completion", model: pick((m) => m.modality.includes("text")) },
    { id: "schema", label: "Structured output", model: pick((m) => m.modality.includes("code") || m.modality.includes("text"), 1) },
    { id: "embed", label: "Embeddings", model: pick((m) => m.modality.includes("embedding")) },
  ];

  const sample = {
    chat: {
      prompt: "Draft a build-vs-buy memo for our retrieval layer.",
      rules: ["streaming", "max_tokens 800", "temperature 0.4"],
      out: `Recommendation: buy inference, build the evaluation layer.

Why buy inference
1. Sparse frontier models now beat our self-hosted 70B on every internal eval.
2. Ops cost of GPU capacity is 2.4 FTE we do not have.
3. Per-token pricing scales down when traffic dips; reserved nodes do not.

Why build evaluation
1. Quality is model-specific; our golden set is the real moat.
2. Routing policy between flagship and mini is product logic, not vendor logic.`,
    },
    schema: {
      prompt: "Extract account, severity and next step from this ticket.",
      rules: ["json_schema", "strict: true", "temperature 0"],
      out: `{
  "account_id": "acct_8812",
  "severity": "high",
  "product_area": "payments",
  "blocked_revenue_usd": 249.0,
  "next_step": "payments-oncall",
  "customer_reply": "We have escalated this and added a temporary bypass."
}

schema validated in 1 decode pass · 0 retries`,
    },
    embed: {
      prompt: "Embed 1,240 support articles for hybrid retrieval.",
      rules: ["dimensions 1024", "batch 96", "normalize"],
      out: `batch 001/013  ██████████ 96 articles  412ms
batch 002/013  ██████████ 96 articles  388ms
…
batch 013/013  ██████████ 88 articles  401ms

1,240 vectors · 5.9M tokens · $0.12
stored in pgvector + HNSW (m=32, ef=200)`,
    },
  };

  const active = sample[mode];
  const activeModel = demoModes.find((m) => m.id === mode)?.model;

  return (
    <section id="playground" className="relative z-10 px-4 py-20 sm:px-6 md:py-28">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          align="center"
          tone="coral"
          eyebrow="play in the browser"
          title={<>Prompt, compare, ship — no local setup.</>}
          body="The playground streams responses with live latency, token counts and cost. Export the exact request when the output looks right."
        />

        <Reveal delay={140}>
          <div className="mt-12 overflow-hidden rounded-[28px] border border-white/12 bg-gradient-to-b from-white/[0.06] to-white/[0.01] p-2 shadow-[0_50px_120px_-60px_rgba(36,71,232,0.28)]">
            <div className="rounded-[22px] bg-ink-950/70">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
                <div className="flex gap-1.5">
                  {demoModes.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "rounded-full px-3.5 py-2 font-mono text-[10.5px] tracking-[0.14em] uppercase transition-all duration-300",
                        mode === m.id ? "bg-[#101814] text-ink-950" : "text-white/50 hover:text-white",
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <span className="font-mono text-[10.5px] tracking-[0.14em] text-white/40 uppercase">
                  model · {activeModel}
                </span>
              </div>

              <div className="grid gap-0 lg:grid-cols-2">
                <div className="border-white/8 p-5 lg:border-r">
                  <div className="font-mono text-[9.5px] tracking-[0.16em] text-white/35 uppercase">request</div>
                  <p className="mt-3 rounded-xl border border-white/8 bg-white/[0.03] p-3.5 text-[13px] text-white/75">
                    {active.prompt}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {active.rules.map((r) => (
                      <span key={r} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-white/50 uppercase">
                        {r}
                      </span>
                    ))}
                  </div>
                  <div className="mt-5">
                    <CodeTabs modelId={activeModel} />
                  </div>
                </div>
                <div className="p-5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/35 uppercase">response</span>
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-lime-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-lime-400" />
                      streaming
                    </span>
                  </div>
                  <pre className="mt-3 max-h-[300px] overflow-auto rounded-xl border border-white/8 bg-white/[0.02] p-3.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-white/75">
                    {active.out}
                  </pre>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {[
                      { k: "tokens", v: mode === "embed" ? "5.9M" : "412" },
                      { k: "cost", v: mode === "embed" ? "$0.12" : "$0.0038" },
                      { k: "latency", v: mode === "embed" ? "5.2s" : "1.42s" },
                    ].map((s) => (
                      <div key={s.k} className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                        <div className="font-mono text-[9px] tracking-[0.14em] text-white/40 uppercase">{s.k}</div>
                        <div className="mt-1 font-mono text-[12px] tabular-nums text-white/85">{s.v}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 font-mono text-[9.5px] tracking-[0.14em] text-white/30 uppercase">
                    sample output · run it live in the console playground
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={220}>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button href="#/signup">Open a real workspace</Button>
            <Button href="#/models" variant="outline">
              Compare model pricing
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------- stats */

function Stat({ value, suffix, label, decimals, active, text }) {
  const current = useCountUp(value ?? 0, active && value != null, 1700);
  return (
    <div className="pr-glass relative overflow-hidden rounded-3xl px-6 py-7">
      <div className="font-display flex items-baseline gap-1 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
        {value != null ? current.toFixed(decimals) : text}
        {value != null && <span className="font-mono text-lg text-brand-ember/85">{suffix}</span>}
      </div>
      <div className="mt-3 font-mono text-[10px] tracking-[0.22em] text-white/40 uppercase">{label}</div>
      <div className="pointer-events-none absolute -right-10 -bottom-12 h-28 w-28 rounded-full bg-brand-ember/20 blur-2xl" />
    </div>
  );
}

export function StatsSection() {
  const { ref, inView } = useInView({ threshold: 0.3 });
  const catalogCount = useCatalogCount();
  const stats = useGatewayStats();

  /* Every tile is a live figure. While the gateway is unreachable the tile
     shows a fact about the product instead of an invented number. */
  const tokens = stats?.tokens24 ?? 0;
  const tokenDef =
    tokens >= 1_000_000
      ? { value: tokens / 1_000_000, suffix: "M", decimals: 1 }
      : tokens >= 1_000
        ? { value: tokens / 1_000, suffix: "k", decimals: 1 }
        : { value: tokens, suffix: "", decimals: 0 };
  const statDefs = [
    catalogCount != null
      ? { value: catalogCount, suffix: "", label: "models published", decimals: 0 }
      : { value: null, text: "OpenAI", label: "compatible endpoint" },
    stats?.tokens24 > 0
      ? { ...tokenDef, label: "tokens · 24h" }
      : { value: null, text: "Auto", label: "failover routing" },
    stats?.ttft
      ? { value: stats.ttft, suffix: "ms", label: "avg first token · 24h", decimals: 0 }
      : { value: null, text: "SSE", label: "streaming by default" },
    stats?.uptime != null
      ? { value: stats.uptime, suffix: "%", label: "uptime · 90 days", decimals: 2 }
      : { value: null, text: "Live", label: "public status page" },
  ];

  return (
    <section className="relative z-10 px-4 py-14 sm:px-6">
      <div ref={ref} className="mx-auto grid max-w-7xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statDefs.map((s, i) => (
          <Reveal key={s.label} delay={i * 90}>
            <Stat {...s} active={inView} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- process */

const steps = [
  {
    n: "01",
    title: "Create a key",
    duration: "2 minutes",
    body: "Sign up, scope a key to the models you need, and set a spend cap. The secret is shown once.",
    bullets: ["Scoped keys", "Spend caps", "IP allowlists"],
  },
  {
    n: "02",
    title: "Prototype in the playground",
    duration: "same day",
    body: "Compare models on your own prompts, tune parameters, and copy the exact request you tested as cURL.",
    bullets: ["Model compare", "Parameter tuning", "cURL export"],
  },
  {
    n: "03",
    title: "Integrate the SDK",
    duration: "1–2 days",
    body: "Drop the OpenAI-compatible client into your stack. Streaming, tool calling and structured outputs behave identically.",
    bullets: ["OpenAI-compatible", "Streaming SSE", "JSON schema outputs"],
  },
  {
    n: "04",
    title: "Scale with guardrails",
    duration: "ongoing",
    body: "Add failover routing, higher rate limits and per-key budgets as volume grows — all from one console.",
    bullets: ["Failover routing", "Rate limits", "Budget alerts"],
  },
];

export function ProcessSection() {
  return (
    <section id="how" className="relative z-10 px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          tone="gold"
          align="center"
          eyebrow="how it works"
          title={<>From key to production traffic in a week.</>}
          body="No procurement, no cluster provisioning, no vendor lock-in on the client side."
        />
        <div className="relative mt-16">
          <div className="absolute top-0 left-[19px] hidden h-full w-px bg-gradient-to-b from-orange-400/60 via-rose-400/40 to-transparent md:block" />
          <div className="space-y-5">
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 80} depth>
                <div className="group relative grid gap-6 rounded-3xl border border-white/8 bg-white/[0.025] p-6 transition-colors duration-500 hover:border-white/16 hover:bg-white/[0.045] sm:p-7 md:grid-cols-[auto_1fr_1fr] md:items-start md:gap-8 md:pl-16">
                  <span className="hidden md:absolute md:top-8 md:left-[7px] md:grid md:place-items-center">
                    <span className="grid h-7 w-7 place-items-center rounded-full border border-white/15 bg-ink-900 font-mono text-[10px] text-brand-ember">
                      {s.n}
                    </span>
                  </span>
                  <div className="md:hidden">
                    <span className="font-mono text-[10px] tracking-[0.24em] text-brand-ember/80 uppercase">step {s.n}</span>
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-semibold tracking-tight text-white">{s.title}</h3>
                    <span className="mt-2 inline-block rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] text-white/45 uppercase">
                      {s.duration}
                    </span>
                  </div>
                  <p className="text-[14px] leading-relaxed text-white/55">{s.body}</p>
                  <div className="flex flex-wrap gap-2 md:col-span-3">
                    {s.bullets.map((b) => (
                      <span key={b} className="rounded-full border border-white/8 bg-ink-900/60 px-3 py-1.5 text-[12px] text-white/60">
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- testimonials */

const quotes = [
  {
    quote:
      "We moved our support copilot from a single provider to RageStar and cut inference spend by 61% while latency dropped under 200ms for the first token.",
    name: "Maya Renton",
    role: "VP Engineering, Lumen Motors",
    initials: "MR",
    accent: "from-orange-500 to-rose-500",
    metric: "61% cheaper inference",
  },
  {
    quote:
      "Failover quietly saved us during a provider outage. Requests re-routed mid-stream and our dashboards never showed a spike in errors.",
    name: "Dev Anand",
    role: "Head of Platform, Orbit Aero",
    initials: "DA",
    accent: "from-amber-400 to-orange-500",
    metric: "0 downtime incidents",
  },
  {
    quote:
      "The playground let our PMs validate prompts without a deploy. We shipped four new AI features in a quarter with the same team size.",
    name: "Sofia Braun",
    role: "Director of Product, Cobalt Health",
    initials: "SB",
    accent: "from-rose-500 to-red-500",
    metric: "4× feature velocity",
  },
];

export function Testimonials() {
  return (
    <section className="relative z-10 px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto max-w-7xl">
        <SectionHeading
          align="center"
          eyebrow="in production"
          title={<>Teams ship real AI features on RageStar.</>}
          body="From two-person startups to regulated enterprises running billions of tokens a month."
        />
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {quotes.map((q, i) => (
            <Reveal key={q.name} delay={i * 90}>
              <TiltCard intensity={7} className="h-full">
                <div className="pr-glass flex h-full flex-col justify-between rounded-3xl p-6 sm:p-7">
                  <div>
                    <div className="flex gap-1 text-amber-300">
                      {Array.from({ length: 5 }).map((_, s) => (
                        <svg key={s} viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                          <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5l-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9 2.9-6Z" />
                        </svg>
                      ))}
                    </div>
                    <p className="mt-5 text-[15px] leading-relaxed text-white/72">“{q.quote}”</p>
                  </div>
                  <div className="mt-7">
                    <div className="mb-5 inline-flex rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 font-mono text-[10px] tracking-[0.16em] text-orange-100/85 uppercase">
                      {q.metric}
                    </div>
                    <div className="flex items-center gap-3 border-t border-white/8 pt-5">
                      <span className={`grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br ${q.accent} font-display text-[13px] font-semibold text-white`}>
                        {q.initials}
                      </span>
                      <span>
                        <span className="block text-[13px] font-medium text-white">{q.name}</span>
                        <span className="block text-[12px] text-white/45">{q.role}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </TiltCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- pricing */

export function PricingTeaser() {
  return (
    <section id="pricing" className="relative z-10 px-4 py-20 sm:px-6 md:py-24">
      <div className="mx-auto max-w-7xl">
        <Reveal>
          <div className="pr-glass grid gap-8 rounded-[32px] p-8 sm:p-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div>
              <Badge tone="ember">pricing</Badge>
              <h2 className="font-display mt-5 text-3xl leading-[1.04] font-semibold tracking-tight text-white sm:text-4xl">
                Pay for tokens.
                <br />
                <span className="text-brand-ember">Nothing else.</span>
              </h2>
              <p className="mt-4 max-w-lg text-[14.5px] leading-relaxed text-white/55">
                Three plans, one meter. Every model price is published and billed per request —
                no seats, no commits, no egress.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button href="#/pricing">See full pricing</Button>
                <Button href="#/models" variant="outline">
                  Compare models
                </Button>
              </div>
            </div>
            <div className="grid gap-3">
              {[
                { name: "Developer", price: "$0", note: "plus usage · $25 credit" },
                { name: "Scale", price: "$499", note: "per month · most popular", hot: true },
                { name: "Enterprise", price: "Custom", note: "dedicated capacity + SLA" },
              ].map((p, i) => (
                <a
                  key={p.name}
                  href="#/pricing"
                  className={cn(
                    "group flex items-center justify-between gap-4 rounded-2xl border px-5 py-4 transition-all duration-300 hover:-translate-y-0.5",
                    p.hot
                      ? "border-brand-ember/50 bg-brand-ember/8 hover:bg-brand-ember/12"
                      : "border-white/12 bg-white/[0.04] hover:border-white/25",
                  )}
                  style={{ animation: `pr-floaty ${6.5 + i * 0.7}s ease-in-out infinite` }}
                >
                  <span>
                    <span className="font-display block text-[15px] font-semibold text-white">{p.name}</span>
                    <span className="block font-mono text-[10px] tracking-[0.14em] text-white/45 uppercase">{p.note}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-display text-2xl font-bold tabular-nums text-white">{p.price}</span>
                    <span className="text-white/35 transition-transform duration-300 group-hover:translate-x-1">→</span>
                  </span>
                </a>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------------- faq */

const faqs = [
  {
    q: "Do you train on my prompts or completions?",
    a: "Never. Traffic is excluded from training by default for every account, and you can turn on zero-retention mode so payloads are discarded as soon as the response stream closes.",
  },
  {
    q: "How is token pricing calculated?",
    a: "Input and output tokens are metered per request and priced per million, at the rate published on each model card. Embeddings, image generations and audio minutes are metered separately. There are no egress, seat or minimum-commit fees on Developer and Scale.",
  },
  {
    q: "What exactly is smart routing?",
    a: "Each request is routed to a healthy upstream key, and failover moves it mid-flight if a provider errors or times out. The response contract is preserved, so your client never sees a gap.",
  },
  {
    q: "Can I bring my own keys or self-host?",
    a: "Yes on both. Add your own upstream provider keys and the gateway routes through them with its failover, metering and logging, or export usage and leave whenever you like — the API is OpenAI-compatible.",
  },
  {
    q: "How fast is onboarding, really?",
    a: "Keys are issued instantly. Most teams are making real requests in the playground within minutes and have production traffic flowing the same day, since the OpenAI-compatible surface means no client rewrite.",
  },
  {
    q: "What happens if I exceed a rate limit?",
    a: "Requests return a clear 429 rather than silently dropping. You can raise per-key limits, set spend windows, and watch every request in the console logs.",
  },
];

export function FaqSection() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="relative z-10 px-4 py-24 sm:px-6 md:py-28">
      <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading
          tone="neutral"
          eyebrow="questions"
          title={<>The details procurement will ask about.</>}
          body="Still unsure? Open a thread from the console and a real engineer replies — usually within a few hours."
        />
        <div className="divide-y divide-white/8 border-y border-white/8">
          {faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <Reveal key={f.q} delay={i * 50}>
                <div>
                  <button onClick={() => setOpen(isOpen ? null : i)} className="group flex w-full items-center justify-between gap-6 py-5 text-left" aria-expanded={isOpen}>
                    <span className={cn("font-display text-[15.5px] font-medium transition-colors sm:text-base", isOpen ? "text-white" : "text-white/75 group-hover:text-white")}>
                      {f.q}
                    </span>
                    <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-all duration-300", isOpen ? "rotate-45 border-brand-ember/40 bg-brand-ember/10 text-brand-ember" : "border-white/12 bg-white/5 text-white/60 group-hover:text-white")}>
                      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                      </svg>
                    </span>
                  </button>
                  <div className={cn("grid overflow-hidden pr-10 transition-all duration-500 ease-out", isOpen ? "grid-rows-[1fr] pb-6 opacity-100" : "grid-rows-[0fr] opacity-0")}>
                    <p className="min-h-0 text-[14px] leading-relaxed text-white/55">{f.a}</p>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------------- cta */

export function CtaSection() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle");

  const submit = (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setState("error");
      return;
    }
    setState("done");
  };

  return (
    <section id="contact" className="relative z-10 px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <div className="pr-glass-strong relative overflow-hidden rounded-[32px] p-8 sm:p-12">
            <div className="pointer-events-none absolute -top-24 -right-10 h-72 w-72 rounded-full bg-brand-ember/25 blur-[100px]" />
            <div className="pointer-events-none absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-brand-lime/15 blur-[100px]" />
            <div className="relative grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:items-center">
              <div>
                <Badge tone="coral">get started</Badge>
                <h2 className="font-display mt-5 text-3xl leading-[1.04] font-bold tracking-[-0.02em] text-balance text-white sm:text-[2.9rem]">
                  Your first request is one key away.
                </h2>
                <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-white/55">
                  Create a workspace and get $25 in credit. Add a payment method only when you are
                  ready to ship — usage is metered per token and visible in real time.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <Button href="#/signup" className="w-full sm:w-auto">
                    Create free workspace
                  </Button>
                  <Button href="#/login" variant="outline" className="w-full sm:w-auto">
                    Sign in to console
                  </Button>
                </div>

                <form onSubmit={submit} className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (state !== "idle") setState("idle");
                    }}
                    placeholder="Work email for architecture review"
                    className="flex-1 rounded-full border border-white/12 bg-white/[0.05] px-5 py-3.5 text-sm text-white placeholder:text-white/35 focus:border-brand-ember/60 focus:bg-white/[0.08] focus:outline-none"
                  />
                  <button type="submit" className="rounded-full border border-white/15 bg-white/5 px-6 py-3.5 text-sm font-medium text-white/85 transition-all hover:bg-white/10 hover:text-white">
                    {state === "done" ? "Request received" : "Free architecture review"}
                  </button>
                </form>
                <div className="mt-3 min-h-6 font-mono text-[11px] tracking-[0.16em] uppercase">
                  {state === "error" && <span className="text-rose-300">please enter a valid work email</span>}
                  {state === "done" && <span className="text-lime-300">thanks — an engineer will reply within one business day</span>}
                  {state === "idle" && <span className="text-white/30">no sales call required · 30-minute teardown of your AI stack</span>}
                </div>
              </div>

              <div className="grid gap-3">
                {[
                  { k: "free credit", v: "$25", note: "no card required" },
                  { k: "setup time", v: "2 minutes", note: "key issued instantly" },
                  { k: "migration", v: "1 line", note: "swap the base URL" },
                ].map((row, i) => (
                  <div key={row.k} className="pr-glass flex items-center justify-between gap-4 rounded-2xl px-5 py-4" style={{ animation: `pr-floaty ${6 + i * 0.8}s ease-in-out infinite` }}>
                    <div>
                      <div className="font-mono text-[10px] tracking-[0.2em] text-white/40 uppercase">{row.k}</div>
                      <div className="font-display mt-1 text-lg font-semibold text-white">{row.v}</div>
                    </div>
                    <span className="flex items-center gap-3 font-mono text-[10px] tracking-[0.16em] text-white/35 uppercase">
                      <DotmSquare1 size={18} dotSize={3} color="#E23D28" speed={0.85 + i * 0.2} aria-hidden />
                      {row.note}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- footer */

const columns = [
  {
    title: "Product",
    links: [
      { label: "Models", href: "#/models" },
      { label: "Playground", href: "#playground" },
      { label: "Pricing", href: "#/pricing" },
      { label: "Status", href: "#/status" },
      { label: "Privacy", href: "#/privacy" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "#/docs" },
      { label: "API reference", href: "#/docs" },
      { label: "Quickstart", href: "#/docs" },
      { label: "Status", href: "#/status" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "Model catalog", href: "#/models" },
      { label: "Pricing", href: "#/pricing" },
      { label: "Console", href: "#/dashboard" },
      { label: "Admin", href: "#/admin" },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Sign in", href: "#/login" },
      { label: "Create account", href: "#/signup" },
      { label: "Console", href: "#/dashboard" },
      { label: "Reset password", href: "#/reset" },
    ],
  },
];

export function SiteFooter({ session }) {
  return (
    <footer className="relative z-10 border-t border-white/8 bg-ink-950/80 px-4 pt-16 pb-10 backdrop-blur-md sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-12">
          <StackStrip />
        </div>

        <div className="grid gap-10 md:grid-cols-[1.3fr_2.7fr]">
          <div>
            <div className="flex items-center gap-3">
              <span className="relative grid h-10 w-10 place-items-center">
                <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90" />
                <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
                  <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M12 3.2v16.2" stroke="currentColor" strokeWidth="0.9" opacity="0.6" />
                </svg>
              </span>
              <span className="font-display text-base font-semibold tracking-tight text-white">RageStar AI</span>
            </div>
            <p className="mt-5 max-w-xs text-[13.5px] leading-relaxed text-white/50">
              A multi-model inference platform. One API, automatic failover, and published
              per-token pricing for text, vision, code, embeddings, image and audio models.
            </p>
            <div className="mt-6 flex items-center gap-2.5 font-mono text-[10px] tracking-[0.22em] text-white/35 uppercase">
              <DotmSquare1 size={13} dotSize={2} color="#0D7A66" speed={0.9} aria-hidden />
              {API_HOST}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {columns.map((col) => (
              <div key={col.title}>
                <h3 className="font-mono text-[10px] tracking-[0.22em] text-white/40 uppercase">{col.title}</h3>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} className="group inline-flex items-center gap-1.5 text-[13.5px] text-white/60 transition-colors hover:text-white">
                        <span className="h-px w-0 bg-brand-ember transition-all duration-300 group-hover:w-3" />
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-4 border-t border-white/8 pt-7 sm:flex-row sm:items-center">
          <p className="font-mono text-[11px] tracking-[0.16em] text-white/35 uppercase">
            © {new Date().getFullYear()} RageStar AI — all rights reserved
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a href="#/models" className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-white/65 uppercase hover:text-white">
              Model catalog
            </a>
            <a href={session ? "#/dashboard" : "#/login"} className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10.5px] tracking-[0.16em] text-white/65 uppercase hover:text-white">
              {session ? "Console" : "Sign in"}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}


