/* ==========================================================================
   RageStarApp — the RageStar UI kit mounted inside the gateway.
   --------------------------------------------------------------------------
   Owns everything under the authenticated routes:
     #/dashboard/<view>          → overview | models | playground | keys |
                                   usage | settings
     #/admin/<view>              → overview | orgs | models | incidents
                                   (gateway admin role required)
     #/ragestar[/<area>/<view>]     → legacy alias for the same kit
   The gateway's hash router treats #/dashboard, #/admin and #/ragestar as
   nested routes and never re-renders on sub-navigation, so this shell
   listens to hashchange itself and swaps views with the kit's page-enter
   animation + route wipe. Navigation targets the canonical #/dashboard and
   #/admin bases so deep links and the command palette line up.
   Identity, plan and credits come from the real gateway session
   (lib/auth.js); the screens themselves are the RageStar demo kit.
   ========================================================================== */

import { useEffect, useMemo, useState } from "react";
import Ambient from "./components/Ambient.jsx";
import { ToastProvider } from "./lib/toast.jsx";
import Dashboard from "./dashboard/Dashboard.jsx";
import AdminPanel from "./admin/Admin.jsx";
import { signOut, useSession } from "../lib/auth.js";
import { acceptPrivacy, myPrivacyAcceptance } from "../lib/db.js";
import { PRIVACY_VERSION, PRIVACY_EFFECTIVE } from "./pages/privacy.jsx";

/* `community` has to be listed here or the deep links resolve to Overview:
   App.jsx already forwards #/community and #/chat to #/dashboard/community,
   and the site header links straight at it. */
const DASH_VIEWS = ["overview", "models", "playground", "keys", "usage", "logs", "community", "settings"];
const DASH_ALIASES = { credits: "usage" };
/* The staff console exposes every section of the real gateway admin panel —
   the ids match the tab ids in src/pages/Admin.jsx, so #/admin/<section>
   deep links keep working. */
const ADMIN_VIEWS = [
  "overview",
  "keys",
  "upstreams",
  "routing",
  "compressor",
  "models",
  "kie",
  "inbox",
  "users",
  "issued",
  "referrals",
  "credits",
  "ip",
  "audit",
  "logs",
  "gate",
  "files",
  "announcements",
  "settings",
];

function parseRageStarRoute() {
  const clean = (window.location.hash || "")
    .replace(/^#\/?/, "")
    .split("?")[0]
    .replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  const rest = parts[0] === "ragestar" ? parts.slice(1) : parts;
  if (rest[0] === "admin") {
    return { area: "admin", view: ADMIN_VIEWS.includes(rest[1]) ? rest[1] : "overview" };
  }
  const candidate = rest[0] === "dashboard" ? rest[1] : rest[0];
  const view = DASH_ALIASES[candidate] ?? candidate;
  if (DASH_VIEWS.includes(view)) return { area: "dashboard", view };
  return { area: "dashboard", view: "overview" };
}

/* The blocking acceptance screen (v12.14). It is not a toast and cannot be
   dismissed: the only ways out are accepting the current policy or signing out.
   Kept beside the panels so the gate reads as part of the shell, not a page. */
function PrivacyConsentCard({ onAccept, onSignOut, busy, error }) {
  return (
    <div className="pr-glass-strong w-full max-w-lg rounded-3xl border border-white/10 p-6 sm:p-7">
      <span className="font-mono text-[10px] tracking-[0.18em] text-brand-ember uppercase">
        action required
      </span>
      <h1 className="font-display mt-3 text-xl font-bold tracking-tight text-white/85 sm:text-2xl">
        Accept the Privacy Policy to continue
      </h1>
      <p className="mt-4 text-[13.5px] leading-relaxed text-white/65">
        Before you can use the dashboard, you need to accept RageStar's Privacy Policy. It explains
        what we collect and, importantly, that the prompts, messages, files and other inputs you
        send to the gateway (the requests), and the outputs it returns to you (the responses), are
        stored, reviewed, processed and used by the company, including to operate, improve, develop,
        train and fine-tune its services and models.
      </p>
      <p className="mt-4 font-mono text-[10.5px] tracking-[0.14em] text-white/65 uppercase">
        version {PRIVACY_VERSION} · effective {PRIVACY_EFFECTIVE}
      </p>
      <a
        href="#/privacy"
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-block text-[13px] text-brand-ember underline decoration-brand-ember/40 underline-offset-4 hover:decoration-brand-ember"
      >
        Read the full policy
      </a>
      {error && (
        <p className="mt-4 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={onAccept}
          disabled={busy}
          className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-6 py-3 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)] disabled:opacity-60"
        >
          {busy ? "Recording…" : "Accept and continue"}
        </button>
        <button
          onClick={onSignOut}
          className="rounded-full border border-white/12 bg-white/5 px-5 py-3 text-[13px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function RageStarApp() {
  const { user, profile, isAdmin } = useSession();
  const [route, setRoute] = useState(parseRageStarRoute);
  const [wipeKey, setWipeKey] = useState(0);
  /* The rs_live_ key handed from the Keys view's reveal dialog to the
     playground ("Use in playground"). It lives HERE, above the per-view
     remount (the page-enter key below), exactly like the old Workspace
     shell's presetKey — so the key survives the keys → playground view
     change and the first prompt is a real, logged gateway call. Component
     state only, never storage: it is a bearer credential. */
  const [playgroundKey, setPlaygroundKey] = useState("");
  /* Privacy gate state. `privacy === null` means the read is still in flight. */
  const [privacy, setPrivacy] = useState(null);
  const [privacyError, setPrivacyError] = useState(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    const onHash = () => {
      const next = parseRageStarRoute();
      setRoute((prev) => {
        if (prev.area === next.area && prev.view === next.view) return prev;
        setWipeKey((k) => k + 1);
        return next;
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* Read the account's accepted privacy version. A failed read or an unmigrated
     database answers `unavailable`, and the gate stands down rather than
     locking everyone out of their own console — an error is not a refusal. */
  useEffect(() => {
    let alive = true;
    const id = user?.id;
    if (!id) return undefined;
    setPrivacy(null);
    setPrivacyError(null);
    myPrivacyAcceptance(id)
      .then((row) => {
        if (alive) setPrivacy(row);
      })
      .catch((err) => {
        if (!alive) return;
        setPrivacyError(err?.message || "Could not read your privacy status.");
        setPrivacy({ unavailable: true });
      });
    return () => {
      alive = false;
    };
  }, [user?.id]);

  /* Kit paths are semantic ("dashboard/keys", "admin", ""), so navigation can
     target the canonical #/dashboard and #/admin bases no matter which of
     the three mounts (#/dashboard, #/admin, #/ragestar) we are currently on. */
  const navigate = (path) => {
    const clean = String(path ?? "").replace(/^\/+/, "");
    let next;
    if (clean === "" || clean === "#") {
      next = "#/";
    } else if (clean === "admin" || clean.startsWith("admin/") || clean === "dashboard" || clean.startsWith("dashboard/")) {
      next = `#/${clean}`;
    } else {
      next = `#/dashboard/${clean}`;
    }
    if (window.location.hash === next) return;
    window.location.hash = next;
  };

  /* gateway session → the shape the kit expects */
  const session = useMemo(() => {
    const email = profile?.email || user?.email || "operator@ragestar.local";
    const name =
      profile?.full_name || user?.user_metadata?.full_name || email.split("@")[0] || "Operator";
    const org = (profile?.org || user?.user_metadata?.org || "workspace")
      .toString()
      .toLowerCase();
    const planRaw = (profile?.plan || "developer").toString();
    const plan = planRaw.charAt(0).toUpperCase() + planRaw.slice(1);
    const credits = Number(profile?.credit_balance_usd ?? 0) || 0;
    return { email, name, org, plan, credits };
  }, [user, profile]);

  const exitToSite = () => {
    window.location.hash = "#/";
  };

  const onAcceptPrivacy = async () => {
    setAccepting(true);
    setPrivacyError(null);
    try {
      await acceptPrivacy(PRIVACY_VERSION);
      setPrivacy({
        unavailable: false,
        privacy_version: PRIVACY_VERSION,
        privacy_accepted_at: new Date().toISOString(),
      });
    } catch (err) {
      setPrivacyError(err?.message || "Could not record your acceptance. Try again.");
    } finally {
      setAccepting(false);
    }
  };

  /* `privacy === null` is only meaningful once we know who is signed in. */
  const privacyChecking = Boolean(user?.id) && privacy === null && !privacyError;
  /* Unavailable (unmigrated database, failed read) never blocks; anything else
     blocks unless it already accepted the CURRENT version. */
  const privacyBlocked =
    privacy != null && !privacy.unavailable && privacy.privacy_version !== PRIVACY_VERSION;

  return (
    <ToastProvider>
      <div className="ragestar-scope relative min-h-screen">
        <Ambient intensity={route.area === "dashboard" || route.area === "admin" ? 12 : 26} />
        {privacyChecking ? (
          <div className="relative z-10 grid min-h-screen place-items-center px-4">
            <p className="font-mono text-[10.5px] tracking-[0.16em] text-white/65 uppercase">
              checking privacy acceptance…
            </p>
          </div>
        ) : privacyBlocked ? (
          <div className="relative z-10 grid min-h-screen place-items-center px-4 py-16">
            <PrivacyConsentCard
              onAccept={onAcceptPrivacy}
              onSignOut={signOut}
              busy={accepting}
              error={privacyError}
            />
          </div>
        ) : (
          <div key={`${route.area}:${route.view}`} className="pr-page-enter">
            {route.area === "admin" ? (
              <AdminPanel
                session={session}
                view={route.view}
                navigate={navigate}
                onExit={() => navigate("dashboard")}
                isStaff={isAdmin}
              />
            ) : (
              <Dashboard
                session={session}
                view={route.view}
                navigate={navigate}
                onExit={exitToSite}
                onSignOut={signOut}
                playgroundKey={playgroundKey}
                onUseInPlayground={(key) => {
                  setPlaygroundKey(key);
                  navigate("dashboard/playground");
                }}
                isStaff={isAdmin}
              />
            )}
          </div>
        )}
        {wipeKey > 0 && <div key={wipeKey} className="pr-route-wipe" />}
      </div>
    </ToastProvider>
  );
}
