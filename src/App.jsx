import React, { Suspense, useEffect, useRef, useState, lazy } from "react";
import RequireAuth from "./components/RequireAuth.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { initReveals } from "./lib/interactive.js";
import { initMotion } from "./lib/motion.js";
import Toaster from "./components/ui/Toaster.jsx";
import CommandPalette from "./components/ui/CommandPalette.jsx";
import { ScrollTop } from "./components/ui/interactions.jsx";
import { announce, useConnectionToasts, useScrollProgress } from "./lib/ux.js";
import { signOut, useSession } from "./lib/auth.js";
import RouteLoader from "./components/RouteLoader.jsx";

/* The whole site now runs the RageStar UI kit (ported from the create-3d
   landing page project): landing, models, pricing, docs, status, auth and
   the two authenticated workspaces. Every screen is a lazy chunk so the
   first paint only pays for the RouteLoader + the page you actually
   opened. The gateway shell (hash router, transitions, error boundary,
   toasts, command palette) stays. */
const RageStarHome = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarHome })));
const RageStarModels = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarModels })));
const RageStarPricing = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarPricing })));
const RageStarDocs = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarDocs })));
const RageStarStatus = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarStatus })));
const RageStarPrivacy = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarPrivacy })));
const RageStarLogin = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarLogin })));
const RageStarSignup = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarSignup })));
const RageStarReset = lazy(() => import("./ragestar/site.jsx").then((m) => ({ default: m.RageStarReset })));
/* The authenticated workspaces (dashboard rail + every console tab; the
   staff admin panel) are the heaviest screens in the kit. */
const RageStarApp = lazy(() => import("./ragestar/RageStarApp.jsx"));

const ROUTES = {
  "#/": RageStarHome,
  "#/models": RageStarModels,
  "#/pricing": RageStarPricing,
  "#/docs": RageStarDocs,
  "#/status": RageStarStatus,
  "#/privacy": RageStarPrivacy,
  "#/dashboard": RageStarApp,
  "#/ragestar": RageStarApp,
  "#/admin": RageStarApp,
  "#/login": RageStarLogin,
  "#/signup": RageStarSignup,
  "#/reset": RageStarReset,
};

const ROUTE_TAGS = {
  "#/": "home",
  "#/models": "model catalog",
  "#/pricing": "pricing",
  "#/docs": "docs",
  "#/status": "status",
  "#/privacy": "privacy policy",
  "#/dashboard": "dashboard",
  "#/ragestar": "ragestar console",
  "#/admin": "admin panel",
  "#/login": "sign in",
  "#/signup": "create account",
  "#/reset": "account recovery",
};

/* What the command palette can jump to. Deliberately kept next to ROUTES so a
   new page cannot be added without deciding whether it is reachable from the
   keyboard. authOnly / adminOnly entries are hidden until they apply. */
const PALETTE_ROUTES = [
  { hash: "#/", label: "Home", keywords: "landing start" },
  { hash: "#/models", label: "Model catalog", keywords: "models llm catalog" },
  { hash: "#/pricing", label: "Pricing", keywords: "price cost credits plans" },
  { hash: "#/docs", label: "Docs", keywords: "documentation api reference curl" },
  { hash: "#/status", label: "Status", keywords: "uptime health incidents" },
  { hash: "#/privacy", label: "Privacy Policy", keywords: "privacy policy data training consent" },
  { hash: "#/dashboard", label: "Dashboard", keywords: "rail workspace overview home unified", authOnly: true },
  { hash: "#/dashboard/playground", label: "Playground", keywords: "try prompt dashboard", authOnly: true },
  { hash: "#/dashboard/keys", label: "API keys", keywords: "rs_live token dashboard", authOnly: true },
  { hash: "#/admin", label: "Admin panel", keywords: "settings users audit", adminOnly: true },
  { hash: "#/login", label: "Sign in", keywords: "login auth" },
  { hash: "#/signup", label: "Create account", keywords: "signup register" },
  { hash: "#/reset", label: "Reset password", keywords: "recover forgot password oobcode" },
];

/* The single workspace is #/dashboard. These tabs are mirrored from the
   RageStar dashboard's own rail so "logs" or "keys" jumps straight to that
   panel instead of the overview. */
const CONSOLE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models available" },
  { id: "playground", label: "Playground", keywords: "try chat prompt" },
  { id: "keys", label: "API keys", keywords: "rs_live token secret rotate" },
  { id: "usage", label: "Usage & billing", keywords: "credits balance spend limits" },
  { id: "logs", label: "Usage logs", keywords: "requests history tokens cost usage sheet" },
  { id: "settings", label: "Settings", keywords: "account name org password" },
];

/* routes that require a session — #/admin additionally requires role = admin */
const GUARDED = { "#/dashboard": false, "#/ragestar": false, "#/admin": true };

/* routes whose own UI owns everything after the base hash, e.g. the dashboard
   renders #/dashboard/community, #/dashboard/keys … as sections of the same
   screen */
const NESTED_ROUTES = ["#/dashboard", "#/admin", "#/ragestar"];

/* Pages that moved. The community portal is a section of the dashboard now
   and exists nowhere else, so its old standalone hash forwards into the
   dashboard instead of rendering a second copy of the portal. The classic
   #/console was retired in v12.8: any of its sub-routes deep-link to the
   matching dashboard section. */
const MOVED = {
  "#/community": "#/dashboard/community",
  "#/chat": "#/dashboard/community",
};

function movedTarget(hash) {
  if (MOVED[hash]) return MOVED[hash];
  if (hash.startsWith("#/community/")) return "#/dashboard/community";
  if (hash === "#/console" || hash.startsWith("#/console/")) {
    const sub = hash.replace(/^#\/console\/?/, "").replace(/\/+$/, "");
    return sub ? `#/dashboard/${sub}` : "#/dashboard";
  }
  return null;
}

function currentRoute() {
  const h = (window.location.hash || "#/").split("?")[0];
  const moved = movedTarget(h);
  if (moved) {
    /* rewrite the address bar so a bookmark heals itself, then resolve the
       route the forward lands on */
    if (window.location.hash !== moved) window.location.replace(moved);
    return "#/dashboard";
  }
  if (ROUTES[h]) return h;
  const nested = NESTED_ROUTES.find((base) => h.startsWith(`${base}/`));
  return nested || "#/";
}

export default function App() {
  const [booted, setBooted] = useState(false);
  const [bootPhase, setBootPhase] = useState("cover");
  const [route, setRoute] = useState(currentRoute);
  const activeRoute = useRef(currentRoute());
  const [transition, setTransition] = useState(null); // { phase: "cover"|"dock", tag }
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute("data-theme") || "dark"
  );
  const pendingRoute = useRef(null);

  /* theme */
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("ragestar-theme", theme); } catch (e) {}
  }, [theme]);

  /* the auth pages carry their own toggle — stay in sync with it */
  useEffect(() => {
    const onThemeEvent = (e) => {
      const next = e.detail || document.documentElement.getAttribute("data-theme");
      if (next) setTheme(next);
    };
    window.addEventListener("ragestar-theme-change", onThemeEvent);
    return () => window.removeEventListener("ragestar-theme-change", onThemeEvent);
  }, []);

  /* Cold boot. Route changes already had a loader; the very first paint had
     nothing, so the app used to appear mid-sentence. The same plate now covers
     the first paint, fills its ring, and hands the mark to whatever chrome the
     landing screen renders. */
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBooted(true);
      return undefined;
    }
    const dock = window.setTimeout(() => setBootPhase("dock"), 760);
    const done = window.setTimeout(() => setBooted(true), 1380);
    return () => {
      window.clearTimeout(dock);
      window.clearTimeout(done);
    };
  }, []);

  /* hash router with packet-sweep transition */
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onHash = () => {
      const next = currentRoute();
      if (next === pendingRoute.current) return;
      /* moving between tabs of the same page is not a page change: skip the
         wipe so the console can swap panels without a full-screen sweep */
      if (next === activeRoute.current) return;
      activeRoute.current = next;
      if (reduced) {
        setRoute(next);
        window.scrollTo(0, 0);
        return;
      }
      pendingRoute.current = next;
      /* 1. cover the whole screen, mark centred */
      setTransition({ phase: "cover", tag: ROUTE_TAGS[next] });
      window.setTimeout(() => {
        /* 2. mount the next screen behind the plate */
        setRoute(next);
        window.scrollTo(0, 0);
        /* 3. let it paint, then hand the mark up to that screen's logo slot */
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            setTransition({ phase: "dock", tag: ROUTE_TAGS[next] });
            window.setTimeout(() => {
              setTransition(null);
              pendingRoute.current = null;
            }, 660);
          });
        });
      }, 420);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* Scroll reveals. Re-armed per route, and it also watches for blocks that
     arrive after a fetch resolves, so late content still fades in. */
  useEffect(() => initReveals(document), [route]);

  /* The same idea for everything that never opted in by hand: cards, stat
     tiles, table rows, the console panels. initMotion arms them by selector
     so the console and admin screens arrive in sequence instead of as one
     dead slab. Re-armed per route; it watches for late content too. */
  useEffect(() => initMotion(document), [route]);

  /* Session state, read here only so the palette can hide what you cannot
     reach. RequireAuth still owns the actual gating. */
  const { isAuthed, isAdmin } = useSession();

  /* Reading progress bar + online/offline toasts, mounted once for the app. */
  useScrollProgress();
  useConnectionToasts();

  /* The hash router never reloads the document, so nothing tells a screen
     reader that the page changed. Announce it in a live region instead. */
  useEffect(() => {
    const tag = ROUTE_TAGS[route];
    if (tag) announce(tag + " loaded");
  }, [route]);

  /* flag auth routes so the shell can drop page padding / scroll chrome */
  useEffect(() => {
    const isAuth = route === "#/login" || route === "#/signup" || route === "#/reset";
    document.body.classList.toggle("is-auth-route", isAuth);
    return () => document.body.classList.remove("is-auth-route");
  }, [route]);

  const Page = ROUTES[route] || RageStarHome;

  /* The router + failure boundary remain the gateway's responsibility. Every
     routed screen now supplies its own RageStar chrome, so there is no parallel
     legacy Header/Footer layer to fight the imported UI kit. */
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>

      {/* screen-to-screen hand-off: plate in, next screen mounts behind it,
          then the mark travels up into the new screen's logo */}
      {!booted ? <RouteLoader phase={bootPhase} label="ragestar gateway" /> : null}
      {transition ? <RouteLoader phase={transition.phase} label={transition.tag} /> : null}

      <div key={route} className="page-enter">
        {/* one bad render should cost you a view, not the whole app */}
        <ErrorBoundary resetKey={route}>
          <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
            {route in GUARDED ? (
              <RequireAuth admin={GUARDED[route]}>
                <Page />
              </RequireAuth>
            ) : (
              <Page />
            )}
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* Global interaction layer. Mounted once, available on every route:
          toasts, the command palette (Cmd/Ctrl+K), and back-to-top. */}
      <Toaster />
      <CommandPalette
        routes={PALETTE_ROUTES}
        consoleTabs={CONSOLE_TABS}
        isAuthed={isAuthed}
        isAdmin={isAdmin}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        onSignOut={signOut}
        /* The visible trigger lives in the header; this mount only owns the
           dialog and the shortcuts. */
        showTrigger={false}
      />
      <ScrollTop />
    </>
  );
}
