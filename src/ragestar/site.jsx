/* ==========================================================================
   site.jsx — the RageStar marketing site, mounted on the gateway's public
   routes (#/, #/models, #/pricing, #/docs, #/status, #/login, #/signup).
   --------------------------------------------------------------------------
   Each exported page wraps itself in the kit's scoped shell:
     · .ragestar-scope  — theme isolation (see ragestar/theme.css)
     · ToastProvider — the kit's toast layer (copy buttons, actions)
     · Ambient       — the drafting-paper backdrop with sparks + scanline
   The gateway's hash router (App.jsx) owns mounting and route transitions;
   these components only own their own content and in-page navigation.
   ========================================================================== */

import { useEffect, useState } from "react";
import Ambient from "./components/Ambient.jsx";
import { ToastProvider } from "./lib/toast.jsx";
import {
  CtaSection,
  FaqSection,
  Hero,
  Nav,
  PartnerStrip,
  Platform,
  PlaygroundDemo,
  PricingTeaser,
  ProcessSection,
  SideRail,
  SiteFooter,
  StatsSection,
  Testimonials,
} from "./components/marketing.jsx";
import { LoginPage, ModelsPage } from "./pages/pages.jsx";
import DocsPage from "./pages/docs.jsx";
import PricingPage from "./pages/pricing.jsx";
import StatusPage from "./pages/status.jsx";
import PrivacyPage from "./pages/privacy.jsx";
import ResetPage from "./pages/reset.jsx";
import { useSession } from "../lib/auth.js";

/* ------------------------------------------------------------------ helpers */

/** In-page navigation for the RageStar pages: "" → site root, "models" → #/models. */
export function ragestarNavigate(path) {
  const clean = String(path ?? "").replace(/^\/+/, "");
  const next = clean === "" || clean === "#" ? "#/" : clean.startsWith("#") ? clean : `#/${clean}`;
  if (window.location.hash === next) return;
  window.location.hash = next;
}

/** The gateway session flattened to what the kit's components expect
    (they only test truthiness and never read fields). */
function useKitSession() {
  const { isAuthed, user } = useSession();
  return isAuthed ? { email: user?.email || "" } : null;
}

/** Reading progress bar — the gradient filament from the RageStar landing. */
function ScrollProgress() {
  const [p, setP] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setP(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="fixed inset-x-0 top-0 z-[60] h-[2px] bg-white/5">
      <div
        className="h-full origin-left bg-gradient-to-r from-orange-500 via-rose-400 to-lime-300 transition-transform duration-150 ease-out"
        style={{ transform: `scaleX(${p})` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- shared shell */

function RageStarShell({ ambient = 26, children }) {
  return (
    <div className="ragestar-scope relative min-h-screen bg-ink-950">
      <Ambient intensity={ambient} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ landing */

export function RageStarHome() {
  const session = useKitSession();

  /* Deep links like #pricing / #faq open the home page and jump to the
     section — the gateway router resolves them to #/, we do the scrolling. */
  useEffect(() => {
    const hash = window.location.hash || "";
    if (!hash || hash.startsWith("#/")) return;
    const id = window.setTimeout(() => {
      document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 160);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <div className="relative">
          <ScrollProgress />
          <Nav session={session} />
          <SideRail />
          <main className="relative z-10">
            <Hero />
            <PartnerStrip />
            <Platform />
            <PlaygroundDemo />
            <StatsSection />
            <ProcessSection />
            <Testimonials />
            <PricingTeaser />
            <FaqSection />
            <CtaSection />
          </main>
          <SiteFooter session={session} />
        </div>
      </ToastProvider>
    </RageStarShell>
  );
}

/* --------------------------------------------------------------- sub pages */

export function RageStarModels() {
  const session = useKitSession();
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <ModelsPage navigate={ragestarNavigate} session={session} />
      </ToastProvider>
    </RageStarShell>
  );
}

export function RageStarDocs() {
  const session = useKitSession();
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <DocsPage navigate={ragestarNavigate} session={session} />
      </ToastProvider>
    </RageStarShell>
  );
}

export function RageStarPricing() {
  const session = useKitSession();
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <PricingPage navigate={ragestarNavigate} session={session} />
      </ToastProvider>
    </RageStarShell>
  );
}

export function RageStarStatus() {
  const session = useKitSession();
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <StatusPage navigate={ragestarNavigate} session={session} />
      </ToastProvider>
    </RageStarShell>
  );
}

export function RageStarPrivacy() {
  const session = useKitSession();
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <PrivacyPage navigate={ragestarNavigate} session={session} />
      </ToastProvider>
    </RageStarShell>
  );
}

/* ------------------------------------------------------------- auth pages */

function RageStarAuth({ mode }) {
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <LoginPage mode={mode} navigate={ragestarNavigate} />
      </ToastProvider>
    </RageStarShell>
  );
}

export function RageStarLogin() {
  return <RageStarAuth mode="signin" />;
}

export function RageStarSignup() {
  return <RageStarAuth mode="signup" />;
}

/* ------------------------------------------------------------ recovery */

/* #/reset — the kit's own take on the gateway's password-recovery flow.
   Same auth calls as the page it replaces (sendPasswordReset /
   completePasswordReset / updatePassword), RageStar's form language. */
export function RageStarReset() {
  return (
    <RageStarShell ambient={26}>
      <ToastProvider>
        <ResetPage navigate={ragestarNavigate} />
      </ToastProvider>
    </RageStarShell>
  );
}
