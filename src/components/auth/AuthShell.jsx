import React, { useEffect, useState } from "react";
import { Logo, ICONS, SafeSvg } from "../brand.jsx";
import { ArrowLeftIcon, CheckIcon } from "../ui/icons.jsx";

/* ==========================================================================
   AuthShell — split screen used by /login, /signup and /reset
   Left  : brand panel + routing visual + what the product actually does
   Right : the form card
   No invented metrics, logos, testimonials or compliance badges live here.
   ========================================================================== */

/* Theme is owned by App, but auth pages render without the header, so they
   keep their own toggle and broadcast the change back. */
function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "dark"
  );

  useEffect(() => {
    const sync = () =>
      setTheme(document.documentElement.getAttribute("data-theme") || "dark");
    window.addEventListener("ragestar-theme-change", sync);
    return () => window.removeEventListener("ragestar-theme-change", sync);
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ragestar-theme", next);
    } catch (e) {
      /* storage disabled */
    }
    setTheme(next);
    window.dispatchEvent(new CustomEvent("ragestar-theme-change", { detail: next }));
  };

  return [theme, toggle];
}

export default function AuthShell({ eyebrow, headline, sub, feats = [], children }) {
  const [, toggleTheme] = useTheme();

  return (
    <main id="main" className="auth-page">
      {/* ------------------------------------------------------------ aside */}
      <aside className="auth-aside">
        <a className="auth-brand" href="#/" aria-label="RageStar home">
          <Logo size={30} />
          <span>
            Rage<span className="dim">Star</span>
          </span>
        </a>

        <div className="auth-lede">
          {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
          <h2 className="auth-headline">
            {headline}
          </h2>
          <p className="auth-sub">{sub}</p>
        </div>

        <div className="auth-proof">
          <div className="auth-proof-head">
            <span>request routing</span>
            <span className="row gap-2">
              <i className="dot dot-ok dot-live" />
              gateway
            </span>
          </div>
          <div className="auth-proof-foot">
            <div>
              <div className="v">1</div>
              <div className="l">endpoint</div>
            </div>
            <div>
              <div className="v">n</div>
              <div className="l">upstream keys</div>
            </div>
            <div>
              <div className="v">0</div>
              <div className="l">keys exposed</div>
            </div>
          </div>
        </div>

        <ul className="auth-feats">
          {feats.map((f) => (
            <li className="auth-feat" key={f.title}>
              {f.icon}
              <span>
                <b>{f.title}</b> — {f.body}
              </span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ------------------------------------------------------------- main */}
      <section className="auth-main">
        <div className="auth-topbar">
          <a className="auth-back" href="#/">
            <ArrowLeftIcon />
            Back to site
          </a>
          <div className="auth-topbar-right">
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle color theme"
            >
              <SafeSvg markup={ICONS.sun + ICONS.moon} />
            </button>
          </div>
        </div>

        <div className="auth-shell">
          <div className="auth-card">
            {children}
          </div>
        </div>

        <div className="auth-meta mono xs">
          <a className="status-pill" href="#/status">
            <span className="dot dot-ok dot-live" />
            live status
          </a>
          <span>·</span>
          <span>accounts secured by supabase auth</span>
        </div>
      </section>
    </main>
  );
}

/* -------------------------------------------------------------- success ---
   Shared post-submit state: terminal-style log, then hand off to the dashboard. */
export function AuthSuccess({ title, sub, lines, redirectTo = "#/dashboard", cta = "Open dashboard now" }) {
  const [shown, setShown] = useState(1);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = reduced ? 40 : 300;
    const iv = setInterval(() => {
      setShown((n) => {
        if (n >= lines.length) {
          clearInterval(iv);
          return n;
        }
        return n + 1;
      });
    }, step);
    return () => clearInterval(iv);
  }, [lines.length]);

  useEffect(() => {
    if (!redirectTo) return;
    if (shown < lines.length) return;
    const t = setTimeout(() => {
      window.location.hash = redirectTo;
    }, 900);
    return () => clearTimeout(t);
  }, [shown, lines.length, redirectTo]);

  return (
    <div className="auth-success">
      <span className="auth-success-mark">
        <CheckIcon />
      </span>
      <div className="auth-card-head" style={{ marginBottom: 0 }}>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <div className="auth-log" role="status" aria-live="polite">
        {lines.slice(0, shown).map((l, i) => (
          <span key={i} className={l.tone || ""}>
            <span className="faint">$ </span>
            {l.text}
          </span>
        ))}
      </div>
      {redirectTo ? (
        <a className="sui-btn sui-btn-primary sui-btn-block" href={redirectTo}>
          <span className="sui-btn-label">{cta}</span>
        </a>
      ) : null}
    </div>
  );
}
