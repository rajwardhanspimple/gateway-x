/* ==========================================================================
   pages.jsx — RageStar site pages, ported from the RageStar landing kit.
   --------------------------------------------------------------------------
   PageNav / ModelsPage are visual ports; LoginPage keeps the kit's design
   but wires the form to the gateway's REAL auth (lib/auth.js: Firebase +
   Supabase bridge, Google provider, email verification, referral codes).
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import {
  ALLOWED_DOMAINS_LABEL,
  signIn as gatewaySignIn,
  signInWithProvider,
  signUp as gatewaySignUp,
} from "../../lib/auth.js";
import { takeDiscordResult } from "../../lib/discord.js";
import { ModelCatalog } from "../dashboard/models.jsx";
import { models } from "../dashboard/data.js";
import { useCatalog } from "../lib/useCatalog.js";
import { Badge, Reveal } from "../components/ui.jsx";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { cn } from "../lib/cn.js";

/* --------------------------------------------------------------- shared nav */

export function PageNav({ navigate, session }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3.5 sm:px-6">
        <button onClick={() => navigate("")} className="flex items-center gap-3">
          <span className="pr-brand-mark relative grid h-9 w-9 place-items-center">
            <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90" />
            <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
              <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M12 3.2v16.2" stroke="currentColor" strokeWidth="0.9" opacity="0.6" />
            </svg>
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight text-white">
            RageStar<span className="ml-1 font-mono text-[10px] tracking-[0.2em] text-white/40 uppercase">ai</span>
          </span>
        </button>

        
<nav className="hidden items-center gap-1 md:flex">
          {[
            { l: "Models", p: "models" },
            { l: "Pricing", p: "pricing" },
            { l: "Docs", p: "docs" },
            { l: "Status", p: "status" },
            { l: "Privacy", p: "privacy" },
            { l: "Playground", p: session ? "dashboard/playground" : "login" },
          ].map((n) => (
            <button
              key={n.l}
              onClick={() => navigate(n.p)}
              className="rounded-full px-3.5 py-2 text-[13px] text-white/60 transition-colors hover:text-white"
            >
              {n.l}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(session ? "dashboard" : "login")}
            className="rounded-full border border-white/12 bg-white/5 px-4 py-2.5 text-[13px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
          >
            {session ? "Console" : "Sign in"}
          </button>
          <button
            onClick={() => navigate(session ? "dashboard/keys" : "signup")}
            className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-4 py-2.5 text-[13px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)]"
          >
            Get API key
          </button>
        </div>
      </div>
    </header>
  );
}

/* --------------------------------------------------------------- login page */


export function LoginPage({ mode, navigate }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [apiKeyMode, setApiKeyMode] = useState(false);
  /* Compulsory consent. Sign-in and sign-up cannot proceed until this is ticked
     — the buttons below are disabled and submit() re-checks it. */
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [consentWarn, setConsentWarn] = useState(false);

  /* A Discord round trip ends at boot, before this page mounts: whatever
     happened there was stashed by lib/discord.js. Say it out loud once. */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result && !result.ok && result.message) setError(result.message);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!acceptedPrivacy) {
      setConsentWarn(true);
      setError("Tick the box to accept the Privacy Policy before continuing.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const res = await gatewaySignUp({ email, password, fullName: name });
        if (res?.needsConfirmation) {
          setNotice("Check your inbox — click the verification link to finish creating your workspace.");
          setBusy(false);
          return;
        }
      } else {
        await gatewaySignIn({ email, password });
      }
      navigate("dashboard");
    } catch (err) {
      setError(err?.message || "Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  
const continueWithGoogle = async () => {
    setError(null);
    setNotice(null);
    if (!acceptedPrivacy) {
      setConsentWarn(true);
      setError("Tick the box to accept the Privacy Policy before continuing.");
      return;
    }
    setBusy(true);
    try {
      await signInWithProvider("google");
      /* a redirect-based flow never resolves here — the browser left */
      navigate("dashboard");
    } catch (err) {
      setError(err?.message || "Google sign-in did not complete.");
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden text-[#101814]">
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6">
        <button onClick={() => navigate("")} className="flex w-fit items-center gap-3">
          <span className="pr-brand-mark relative grid h-9 w-9 place-items-center">
            <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90" />
            <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
              <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="font-display text-[15px] font-semibold tracking-tight text-white">
            RageStar<span className="ml-1 font-mono text-[10px] tracking-[0.2em] text-white/40 uppercase">ai</span>
          </span>
        </button>

        <div className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.05fr_1fr]">
          
<div className="hidden lg:block">
            <Badge tone="ember">
              <DotmSquare1 size={11} dotSize={2} color="#2447E8" speed={1.2} aria-hidden />
              {models.length} models · 5 regions
            </Badge>
            <h1 className="font-display mt-6 text-[2.6rem] leading-[1.03] font-bold tracking-[-0.03em] text-balance text-white">
              The console for every model you ship with.
            </h1>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/55">
              Issue keys, watch per-model latency and spend, and prototype prompts before they hit
              production — all from one workspace.
            </p>

            <div className="mt-9 overflow-hidden rounded-2xl border border-white/10 bg-ink-950/80">
              <div className="flex items-center gap-2 border-b border-white/8 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
                <span className="h-2.5 w-2.5 rounded-full bg-lime-300/70" />
                <span className="ml-2 font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
                  ragestar login
                </span>
              </div>
              <pre className="p-4 font-mono text-[11.5px] leading-relaxed text-white/70">
{`$ ragestar auth login
› verifying workspace…        ok
› loading keys (3)            ok
› default model               ragestar-4-mini
› region                      us-east-1
✓ signed in — welcome back`}
              </pre>
            </div>

            
<div className="mt-7 flex flex-wrap gap-6">
              {[
                { k: "median ttft", v: "184ms" },
                { k: "uptime (90d)", v: "99.99%" },
                { k: "requests / day", v: "1.2B" },
              ].map((s) => (
                <div key={s.k}>
                  <div className="font-display text-xl font-semibold tabular-nums text-white">{s.v}</div>
                  <div className="mt-1 font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{s.k}</div>
                </div>
              ))}
            </div>
          </div>

          
<div className="mx-auto w-full max-w-md">
            <div className="pr-glass-strong rounded-3xl p-6 sm:p-7">
              <div className="flex gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
                {["signin", "signup"].map((m) => (
                  <button
                    key={m}
                    onClick={() => {
                      navigate(m === "signin" ? "login" : "signup");
                      setError(null);
                      setNotice(null);
                    }}
                    className={cn(
                      "flex-1 rounded-full px-3 py-2 font-mono text-[10.5px] tracking-[0.14em] uppercase transition-colors",
                      mode === m ? "bg-[#101814] text-ink-950" : "text-white/50 hover:text-white",
                    )}
                  >
                    {m === "signin" ? "Sign in" : "Create account"}
                  </button>
                ))}
              </div>

              <h2 className="font-display mt-6 text-xl font-semibold tracking-tight text-white">
                {mode === "signin" ? "Welcome back" : "Start building free"}
              </h2>
              <p className="mt-1.5 text-[12.5px] text-white/50">
                {mode === "signin"
                  ? "Sign in to the RageStar console."
                  : "Free to start · no card required."}
              </p>

              
<form onSubmit={submit} className="mt-6 space-y-4">
                {mode === "signup" && (
                  <label className="block">
                    <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">full name</span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ada Lovelace"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-3 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
                    />
                  </label>
                )}

                <label className="block">
                  <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">work email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-3 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
                  />
                </label>

                
<label className="block">
                  <span className="flex items-center justify-between">
                    <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">password</span>
                    {mode === "signin" && (
                      <a
                        href="#/reset"
                        className="font-mono text-[10px] tracking-[0.14em] text-brand-ember uppercase hover:underline"
                      >
                        forgot?
                      </a>
                    )}
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-3 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
                  />
                </label>

                
{mode === "signin" && (
                  <button
                    type="button"
                    onClick={() => setApiKeyMode((v) => !v)}
                    className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.03] px-3.5 py-2.5 text-left"
                  >
                    <span className="font-mono text-[10.5px] tracking-[0.14em] text-white/50 uppercase">
                      sign in with API key instead
                    </span>
                    <span className={cn("text-white/40 transition-transform", apiKeyMode && "rotate-180")}>⌄</span>
                  </button>
                )}

                {apiKeyMode && (
                  <input
                    placeholder="sk_live_…"
                    className="w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-3 font-mono text-[12.5px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
                  />
                )}

                
{mode === "signin" && (
                  <button
                    type="button"
                    onClick={() => setRemember((v) => !v)}
                    className="flex items-center gap-2.5 text-[12.5px] text-white/55"
                  >
                    <span
                      className={cn(
                        "grid place-items-center rounded-md border transition-colors",
                        remember ? "border-brand-ember/60 bg-brand-ember/20" : "border-white/15 bg-white/5",
                      )}
                      style={{ height: 18, width: 18 }}
                    >
                      {remember && (
                        <svg viewBox="0 0 24 24" className="h-3 w-3 text-brand-ember" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    Keep me signed in on this device
                  </button>
                )}

                {/* Compulsory privacy consent. Without it the buttons below stay
                    disabled and submit() refuses to run. The link opens the full
                    policy in a new tab so a half-filled form is not lost. */}
                
<label className="flex items-start gap-2.5 text-[12.5px] text-white/55">
                  <input
                    type="checkbox"
                    checked={acceptedPrivacy}
                    onChange={(e) => {
                      setAcceptedPrivacy(e.target.checked);
                      if (e.target.checked) {
                        setConsentWarn(false);
                        setError(null);
                      }
                    }}
                    className="mt-0.5 h-4 w-4 shrink-0"
                  />
                  <span>
                    I have read and accept the{" "}
                    <a
                      href="#/privacy"
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand-ember underline decoration-brand-ember/40 underline-offset-4 hover:decoration-brand-ember"
                    >
                      Privacy Policy
                    </a>
                  </span>
                </label>

                
{!acceptedPrivacy && consentWarn && (
                  <p className="rounded-xl border border-white/8 bg-white/[0.03] px-3.5 py-2.5 text-[12px] text-white/55">
                    You must accept the Privacy Policy before you can continue.
                  </p>
                )}

                {error && (
                  <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                    {error}
                  </p>
                )}
                {notice && (
                  <p className="rounded-xl border border-lime-400/25 bg-lime-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-lime-200">
                    {notice}
                  </p>
                )}

                
<button
                  type="submit"
                  disabled={busy || !acceptedPrivacy}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3.5 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)] disabled:opacity-60"
                >
                  {busy && (
                    <DotmSquare1 size={14} dotSize={2} color="#E9ECE4" speed={1.5} aria-hidden />
                  )}
                  {busy
                    ? mode === "signin"
                      ? "Verifying…"
                      : "Creating workspace…"
                    : mode === "signin"
                      ? "Sign in to console"
                      : "Create account"}
                </button>
              </form>

              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-white/10" />
                <span className="font-mono text-[10px] tracking-[0.16em] text-white/35 uppercase">or</span>
                <span className="h-px flex-1 bg-white/10" />
              </div>

              
<button
                onClick={continueWithGoogle}
                disabled={busy || !acceptedPrivacy}
                className="flex w-full items-center justify-center gap-2.5 rounded-full border border-white/12 bg-white/5 px-4 py-3 text-[12.5px] text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
                  <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6Z" />
                  <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-6-2.2-7-5.1L1.2 17.2C3.2 21.2 7.3 24 12 24Z" />
                  <path fill="#FBBC05" d="M5 14.3c-.3-.8-.4-1.6-.4-2.3s.2-1.6.4-2.3L1.2 6.8C.4 8.4 0 10.1 0 12s.4 3.6 1.2 5.2L5 14.3Z" />
                  <path fill="#EA4335" d="M12 4.7c2.3 0 3.8.9 4.7 1.8l3.3-3.2C18 1.6 15.2 0 12 0 7.3 0 3.2 2.8 1.2 6.8L5 9.7c1-2.9 3.8-5 7-5Z" />
                </svg>
                Continue with Google
              </button>

              
<p className="mt-6 rounded-xl border border-white/8 bg-white/[0.03] p-3.5 font-mono text-[11px] leading-relaxed text-white/45">
                {ALLOWED_DOMAINS_LABEL ? (
                  <>sign-in is limited to <span className="text-lime-300">{ALLOWED_DOMAINS_LABEL}</span> addresses</>
                ) : (
                  <>your email and password stay between you and the gateway</>
                )}
              </p>
            </div>

            <p className="mt-4 text-center font-mono text-[10.5px] tracking-[0.14em] text-white/30 uppercase">
              protected by soc 2 type ii · no training on your data
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ models page */

export function ModelsPage({ navigate, session }) {
  /* Stats are computed from the LIVE catalog only.

     This used to fall back to the kit fixtures (`live ?? models`), which is
     what put "7 MODELS AVAILABLE" directly above "0 OF 0 MODELS": these tiles
     counted seven built-in fixtures while the ModelCatalog below deliberately
     refused to show models that may not exist on this account. The database
     happening to hold exactly seven published models made the contradiction
     look like a rendering bug rather than two different sources.

     Now both read the same shared request (lib/useCatalog.js), so the tiles and
     the list can only ever agree. While the catalog is loading the tiles show a
     zero count and em dashes, which is true, rather than numbers for a
     workspace nobody is looking at. */
  const live = useCatalog();
  const catalogRows = live ?? [];
  const stats = useMemo(() => {
    const priced = catalogRows.filter((m) => m.priceOut > 0);
    const cheapest = priced.length ? Math.min(...priced.map((m) => m.priceOut)) : null;
    const longest = catalogRows.length ? Math.max(...catalogRows.map((m) => m.context || 0)) : 0;
    const providers = new Set(catalogRows.map((m) => m.provider)).size;
    return [
      { k: "models available", v: `${catalogRows.length}` },
      { k: "providers routed", v: `${providers}` },
      { k: "cheapest output", v: cheapest != null ? `$${cheapest.toFixed(2)} / 1M` : "—" },
      { k: "longest context", v: longest ? `${Math.round(longest / 1000)}k tokens` : "—" },
    ];
  }, [catalogRows]);

  
return (
    <div className="relative min-h-screen text-[#101814]">
      <div className="relative z-10">
        <PageNav navigate={navigate} session={session} />

        <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20">
          <Reveal>
            <Badge tone="ember">
              <DotmSquare1 size={11} dotSize={2} color="#2447E8" speed={1.2} aria-hidden />
              model catalog
            </Badge>
          </Reveal>
          <Reveal delay={70}>
            <h1 className="font-display mt-6 max-w-3xl text-[2.4rem] leading-[1.03] font-bold tracking-[-0.03em] text-balance text-white sm:text-5xl">
              Every frontier model, one{" "}
              <span className="text-brand-ember underline decoration-brand-ember/40 decoration-2 underline-offset-4">
                OpenAI-compatible
              </span>{" "}
              endpoint.
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-white/55 sm:text-base">
              Text, vision, code, embeddings, reranking, image and audio models behind a single API.
              Swap a model id and nothing else changes — routing, retries, streaming and billing are
              handled for you.
            </p>
          </Reveal>

          
<Reveal delay={210}>
            <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {stats.map((s) => (
                <div key={s.k} className="pr-glass rounded-2xl px-5 py-4">
                  <div className="font-display text-xl font-semibold tracking-tight text-white">{s.v}</div>
                  <div className="mt-1.5 font-mono text-[10px] tracking-[0.18em] text-white/40 uppercase">{s.k}</div>
                </div>
              ))}
            </div>
          </Reveal>

          <div className="mt-14">
            <ModelCatalog
              variant="public"
              onTry={() => navigate(session ? "dashboard/playground" : "signup")}
            />
          </div>
        </section>

        <section className="border-t border-white/8 px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-7xl">
            <div className="pr-glass-strong relative overflow-hidden rounded-3xl p-8 sm:p-12">
              <div className="pointer-events-none absolute -top-20 -left-10 h-56 w-56 rounded-full bg-brand-ember/25 blur-[90px]" />
              <div className="relative grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
                
<div>
                  <h2 className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                    Try any model in the browser before you write code.
                  </h2>
                  <p className="mt-3 max-w-xl text-[14.5px] leading-relaxed text-white/55">
                    The playground streams real responses with per-request latency, token counts and
                    cost. Export the exact cURL, Python or TypeScript request when you are happy.
                  </p>
                  <div className="mt-7 flex flex-wrap gap-3">
                    <button
                      onClick={() => navigate(session ? "dashboard/playground" : "signup")}
                      className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-6 py-3 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)]"
                    >
                      Open the playground
                    </button>
                    <button
                      onClick={() => navigate(session ? "dashboard/keys" : "login")}
                      className="rounded-full border border-white/15 bg-white/5 px-6 py-3 text-[13.5px] text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {session ? "Create an API key" : "Sign in"}
                    </button>
                  </div>
                </div>
                
<div className="grid grid-cols-2 gap-3">
                  {[
                    { k: "free credits", v: "$25" },
                    { k: "rate limit", v: "60 rpm" },
                    { k: "setup time", v: "2 min" },
                    { k: "card required", v: "no" },
                  ].map((s) => (
                    <div key={s.k} className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3.5">
                      <div className="font-display text-lg font-semibold text-white">{s.v}</div>
                      <div className="mt-1 font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{s.k}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        
<footer className="border-t border-white/8 px-4 py-10 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
            <p className="font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
              © {new Date().getFullYear()} RageStar AI · inference platform
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => navigate("")}
                className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10.5px] tracking-[0.14em] text-white/60 uppercase hover:text-white"
              >
                ← Back to home
              </button>
              <button
                onClick={() => navigate(session ? "dashboard" : "login")}
                className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10.5px] tracking-[0.14em] text-white/60 uppercase hover:text-white"
              >
                Console
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
