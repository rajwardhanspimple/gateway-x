/* ==========================================================================
   site.jsx — the RageStar marketing site, mounted on the gateway's public
   routes (#/, #/models, #/pricing, #/docs, #/status, #/login, #/signup).
   --------------------------------------------------------------------------
   The landing page (#/) is the "Switchboard Orrery" build in
   components/Landing.jsx: its own stylesheet, its own tokens, scoped under
   .lp, and NO Ambient backdrop — the brief calls for flat colour fields and
   a page that holds still. See src/styles/landing.css for the brief.

   Every other page still wraps itself in the kit's scoped shell:
     · .ragestar-scope  — theme isolation (see ragestar/theme.css)
     · ToastProvider — the kit's toast layer (copy buttons, actions)
     · Ambient       — the drafting-paper backdrop with sparks + scanline
   The gateway's hash router (App.jsx) owns mounting and route transitions;
   these components only own their own content and in-page navigation.
   ========================================================================== */

import { useEffect } from "react";
import Ambient from "./components/Ambient.jsx";
import { ToastProvider } from "./lib/toast.jsx";
import Landing from "./components/Landing.jsx";
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

  /* No RageStarShell here on purpose: the landing page owns its own field
     colour and must not sit on the kit's paper or under the Ambient sparks.
     ToastProvider stays so any copy action still has somewhere to report. */
  return (
    <ToastProvider>
      <Landing navigate={ragestarNavigate} session={session} />
    </ToastProvider>
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
