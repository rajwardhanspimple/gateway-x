/* ==========================================================================
   Workspace — the unified dashboard (#/dashboard)
   --------------------------------------------------------------------------
   The single app shell, and deliberately not a reskin of the admin panel:

     · #/admin    is a grouped strip with a jump box
     · #/dashboard (this file) is a RAIL: grouped sections down the left, a
       sticky top bar with a breadcrumb and a live pulse row, and ONE canvas
       that every section paints into.

   Everything the person owns is a section of this one screen — overview,
   community, playground, keys, models, logs, status, credits, referrals,
   profile, plus an admin snapshot for admins. Same rail, same top bar, same
   canvas for all of them, which is the whole point: one dashboard UI instead
   of a set of separate pages.

   The community portal has no screen of its own any more. #/community
   redirects here (App.jsx) and the header links point at #/dashboard/community,
   so the portal exists in exactly one place: this canvas.

   Sections are addressable: #/dashboard/keys, #/dashboard/community, … and a
   bare #/dashboard lands on Overview. App.jsx normalises the sub-routes back
   to "#/dashboard" for its router, so deep links and reloads keep working.

   Data, errors and mutations live here; every section is a presentational
   component that takes props — the same contract the console tabs already
   have, which is why they can be rendered here untouched.

   RULES OF HOOKS: every hook sits in one block at the top of the component,
   before any early return. scripts/check-ui.mjs enforces this.
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner, PaletteTrigger } from "../components/ui/index.jsx";
import { communityStanding, recordCommunityVisit } from "../lib/db.js";
import { Logo } from "../components/brand.jsx";
import {
  BoltIcon,
  KeyIcon,
  ShieldIcon,
  SparkIcon,
  UserIcon,
} from "../components/ui/icons.jsx";
import {
  initials,
  refreshProfile,
  sendPasswordReset,
  signOut,
  updateProfile,
  useSession,
} from "../lib/auth.js";
import {
  adminDashboard,
  callGateway,
  createKey,
  dailyHealth,
  listMyKeys,
  listMyLogs,
  listMyReferrals,
  listPublicModels,
  myCreditLedger,
  myCredits,
  myReferral,
  referralLink,
  renameKey,
  revokeKey,
  routeHealth,
  setKeyBudget,
  setKeyIpRules,
  usageSeries,
  usageSummary,
} from "../lib/db.js";
import { GATEWAY_URL } from "../lib/supabase.js";
import { compact, money } from "../lib/format.js";
import OverviewTab from "./console/OverviewTab.jsx";
import KeysTab from "./console/KeysTab.jsx";
import CreditsTab from "./console/CreditsTab.jsx";
import ModelsTab from "./console/ModelsTab.jsx";
import StatusTab from "./console/StatusTab.jsx";
import PlaygroundTab from "./console/PlaygroundTab.jsx";
import LogsTab from "./console/LogsTab.jsx";
import ProfileTab from "./console/ProfileTab.jsx";
import ReferralsTab from "./console/ReferralsTab.jsx";
import CommunityPanel from "./workspace/CommunityPanel.jsx";

/* The rail has room for a full name, so unlike the console strip there is no
   short-label compromise here. `group` is the rail heading it sits under. */
const GROUPS = [
  { id: "workspace", label: "Workspace" },
  { id: "build", label: "Build" },
  { id: "usage", label: "Usage" },
  { id: "account", label: "Account" },
  { id: "control", label: "Control" },
];

const TABS = [
  { id: "overview", label: "Overview", group: "workspace", Icon: SparkIcon },
  { id: "community", label: "Community", group: "workspace", Icon: UserIcon },
  { id: "playground", label: "Playground", group: "build", Icon: BoltIcon },
  { id: "keys", label: "API keys", group: "build", Icon: KeyIcon },
  { id: "models", label: "Models", group: "build", Icon: ShieldIcon },
  { id: "logs", label: "Usage logs", group: "usage", Icon: BoltIcon },
  { id: "status", label: "Model status", group: "usage", Icon: ShieldIcon },
  { id: "credits", label: "Credits", group: "account", Icon: SparkIcon },
  { id: "referrals", label: "Referrals", group: "account", Icon: UserIcon },
  { id: "profile", label: "Profile", group: "account", Icon: UserIcon },
  {
    id: "control",
    label: "Admin snapshot",
    group: "control",
    Icon: ShieldIcon,
    adminOnly: true,
  },
];

const IDS = TABS.map((t) => t.id);

/* Deep links people are likely to type or keep in a bookmark from the old
   layout. "dashboard" and "home" both mean the landing section; "chat" and
   the old standalone community route both mean the portal. */
const ALIASES = {
  dashboard: "overview",
  home: "overview",
  chat: "community",
  portal: "community",
  forum: "community",
  key: "keys",
  admin: "control",
};

const ADMIN_JUMPS = [
  { hash: "#/admin", label: "Admin overview", hint: "Live gateway health and traffic" },
  { hash: "#/admin/upstreams", label: "Upstreams", hint: "Providers and base URLs" },
  { hash: "#/admin/keys", label: "Upstream keys", hint: "Pool state and rotation" },
  { hash: "#/admin/users", label: "Users", hint: "Roles, status, access" },
  { hash: "#/admin/credits", label: "Credits", hint: "Balances and grants" },
  { hash: "#/admin/logs", label: "All logs", hint: "Every request, every key" },
];

const RAIL_KEY = "ragestar-dashboard-rail";

function tabFromHash() {
  const raw = (window.location.hash || "")
    .replace(/^#\/dashboard\/?/, "")
    .split("?")[0];
  const id = raw.replace(/\/+$/, "");
  if (ALIASES[id]) return ALIASES[id];
  return IDS.includes(id) ? id : "overview";
}

function readRail() {
  try {
    return localStorage.getItem(RAIL_KEY) === "collapsed";
  } catch (e) {
    return false;
  }
}

/* A snapshot tile renders whatever admin_dashboard() returns without this
   file having to know the RPC's field list — the full breakdown is one click
   away in the admin panel. */
function snapshotTiles(dash) {
  if (!dash || typeof dash !== "object") return [];
  return Object.entries(dash)
    .filter(([, v]) => typeof v === "number" || typeof v === "string")
    .slice(0, 8)
    .map(([k, v]) => ({
      key: k,
      label: k.replace(/_/g, " "),
      value: typeof v === "number" ? compact(v) : String(v),
    }));
}

export default function Workspace() {
  /* =======================================================================
     HOOKS — one block, nothing conditional, nothing after a return
     ======================================================================= */
  const { profile, user, isAdmin, loading: sessionLoading } = useSession();

  const [tab, setTab] = useState(tabFromHash);
  const [collapsed, setCollapsed] = useState(readRail);
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "dark",
  );

  const [keys, setKeys] = useState([]);
  const [logs, setLogs] = useState([]);
  const [models, setModels] = useState([]);
  const [summary, setSummary] = useState(null);
  const [series, setSeries] = useState([]);
  const [credits, setCredits] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [referral, setReferral] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* health and the admin snapshot are only fetched when their section opens */
  const [routes, setRoutes] = useState([]);
  const [days, setDays] = useState([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [dash, setDash] = useState(null);
  const [dashBusy, setDashBusy] = useState(false);
  const [dashLoaded, setDashLoaded] = useState(false);

  /* a freshly created key can be handed straight to the playground */
  const [presetKey, setPresetKey] = useState("");

  /* community check-in: feeds the rail's unread dot and the paused-gateway
     strip. Polled rather than subscribed - one cheap RPC every 20s. */
  const [standing, setStanding] = useState(null);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      if (!document.hidden) {
        communityStanding()
          .then((next) => {
            if (alive && next) setStanding(next);
          })
          .catch(() => {});
      }
    };
    pull();
    const timer = setInterval(pull, 20000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /* opening the community tab is the daily check-in */
  useEffect(() => {
    const ping = () => {
      if (String(window.location.hash || "").includes("community")) {
        recordCommunityVisit("dashboard").catch(() => {});
      }
    };
    ping();
    window.addEventListener("hashchange", ping);
    return () => window.removeEventListener("hashchange", ping);
  }, []);

  const communityUnread = Number(standing?.unread_total || 0);
  const gateNeed = Math.max(0, Number(standing?.remaining ?? 0));
  const gateLocked = standing?.enabled !== false && standing?.unlocked === false;

  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.adminOnly || isAdmin),
    [isAdmin],
  );

  const go = useCallback((id) => {
    const next = IDS.includes(id) ? id : "overview";
    setTab(next);
    const target = next === "overview" ? "#/dashboard" : `#/dashboard/${next}`;
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  /* ---------------------------------------------------------------- routing */
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* the rail is a vertical tablist: one tab stop, arrow keys move between
     sections, Home/End jump to the ends (roving focus) */
  const onRailKeys = useCallback(
    (e) => {
      const moves = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const ids = visibleTabs.map((t) => t.id);
      const at = ids.indexOf(tab);
      const next =
        move === "first"
          ? ids[0]
          : move === "last"
            ? ids[ids.length - 1]
            : ids[(at + move + ids.length) % ids.length];
      go(next);
      const el = document.getElementById(`wk-tab-${next}`);
      if (el) el.focus();
    },
    [tab, go, visibleTabs],
  );

  /* theme lives on <html>; App.jsx and the auth screens listen for the same
     event, so the toggle stays in sync everywhere */
  useEffect(() => {
    const sync = () =>
      setTheme(document.documentElement.getAttribute("data-theme") || "dark");
    window.addEventListener("ragestar-theme-change", sync);
    return () => window.removeEventListener("ragestar-theme-change", sync);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? "collapsed" : "open");
    } catch (e) {
      /* storage disabled — the rail just forgets between visits */
    }
  }, [collapsed]);

  /* ------------------------------------------------------------------ load */
  const load = useCallback(async () => {
    setError("");
    try {
      const [k, l, m, s, ser, cr, led, ref, refs] = await Promise.all([
        listMyKeys(),
        listMyLogs(100),
        listPublicModels(),
        usageSummary(30),
        usageSeries(14),
        myCredits(),
        myCreditLedger(50),
        myReferral(),
        listMyReferrals(),
      ]);
      setKeys(k || []);
      setLogs(l || []);
      setModels(m || []);
      setSummary(s || null);
      setSeries(ser || []);
      setCredits(cr || null);
      setLedger(led || []);
      setReferral(ref || null);
      setReferrals(refs || []);
    } catch (err) {
      setError(err.message || "Could not load your dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const [r, d] = await Promise.all([routeHealth(), dailyHealth()]);
      setRoutes(r || []);
      setDays(d || []);
      setHealthLoaded(true);
    } catch (err) {
      setError(err.message || "Could not load route health.");
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "status" && !healthLoaded && !healthLoading) loadHealth();
  }, [tab, healthLoaded, healthLoading, loadHealth]);

  const loadDash = useCallback(async () => {
    setDashBusy(true);
    try {
      setDash(await adminDashboard());
      setDashLoaded(true);
    } catch (err) {
      setError(err.message || "Could not load the admin snapshot.");
    } finally {
      setDashBusy(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "control" && isAdmin && !dashLoaded && !dashBusy) loadDash();
  }, [tab, isAdmin, dashLoaded, dashBusy, loadDash]);

  /* =======================================================================
     HANDLERS — no hooks past this point
     ======================================================================= */

  /* Errors are intentionally re-thrown where a panel shows them inline, which
     is where the person is looking. */
  const onCreate = async (payload) => {
    setError("");
    const row = await createKey(payload);
    try {
      setKeys(await listMyKeys());
    } catch {
      /* the key exists either way — the list catches up on the next refresh */
    }
    return row;
  };

  const onRevoke = async (id) => {
    try {
      await revokeKey(id);
      setKeys(await listMyKeys());
    } catch (err) {
      setError(err.message);
    }
  };

  const onRename = async (id, current) => {
    const next = window.prompt("New name for this key", current || "");
    if (next === null) return;
    try {
      await renameKey(id, next.trim() || current);
      setKeys(await listMyKeys());
    } catch (err) {
      setError(err.message);
    }
  };

  const onBudget = async (id, current) => {
    const next = window.prompt("Monthly budget in USD (blank = no cap)", current ?? "");
    if (next === null) return;
    try {
      await setKeyBudget(id, next.trim() === "" ? null : Number(next));
      setKeys(await listMyKeys());
    } catch (err) {
      setError(err.message);
    }
  };

  const onIpRules = async (id, current) => {
    const ips = window.prompt(
      "Allowed IPs or CIDR ranges, comma separated (blank = any address)",
      (current?.allowed_ips ?? []).join(", "),
    );
    if (ips === null) return;
    const rpm = window.prompt(
      "Requests per minute per IP for this key (0 = use workspace default)",
      String(current?.ip_rate_limit_rpm ?? 0),
    );
    if (rpm === null) return;
    try {
      await setKeyIpRules(id, {
        ips: ips
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        rpm: rpm.trim() === "" ? 0 : Number(rpm),
      });
      setKeys(await listMyKeys());
    } catch (err) {
      setError(err.message);
    }
  };

  const onRun = async ({ apiKey, model, prompt }) => {
    try {
      const res = await callGateway({ apiKey, model, prompt });
      load();
      return res;
    } catch (err) {
      return { ok: false, status: 0, error: err.message, elapsed: 0, headers: {} };
    }
  };

  const onUseInPlayground = (key) => {
    setPresetKey(key);
    go("playground");
  };

  const onSaveProfile = async ({ fullName, org }) => {
    await updateProfile({ fullName, org });
    await refreshProfile();
  };

  const toggleTheme = () => {
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

  const email = profile?.email || user?.email || "";
  const name = profile?.full_name || email.split("@")[0] || "there";
  const active = TABS.find((t) => t.id === tab) || TABS[0];
  const activeGroup =
    GROUPS.find((g) => g.id === active.group)?.label || "Workspace";
  const activeKeys = keys.filter((k) => k.status === "active").length;
  const shared = { onRefresh: load, onGo: go, gatewayUrl: GATEWAY_URL };

  if (loading && sessionLoading) {
    return (
      <main id="main" className="container section gate-wait">
        <Spinner size={22} />
        <p className="muted small mt-4">Loading your dashboard…</p>
      </main>
    );
  }

  return (
    <main id="main" className="wk-page">
      <div className="wk-shell" data-collapsed={collapsed ? "true" : "false"}>
        {/* ============================================================ rail */}
        <aside className="wk-rail">
          <div className="wk-rail-top">
            <a className="wk-brand" href="#/" title="RageStar home">
              <Logo size={28} />
              <span className="wk-brand-name">
                Rage<span className="dim">Star</span>
              </span>
            </a>
            <span className="wk-brand-tag">rail</span>
            <button
              type="button"
              className="wk-rail-toggle"
              aria-label={collapsed ? "Expand the rail" : "Collapse the rail"}
              title={collapsed ? "Expand the rail" : "Collapse the rail"}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? "»" : "«"}
            </button>
          </div>

          <div className="wk-rail-scroll">
            {GROUPS.map((group) => {
              const items = visibleTabs.filter((t) => t.group === group.id);
              if (!items.length) return null;
              return (
                <div className="wk-group" key={group.id}>
                  <span className="wk-group-label">{group.label}</span>
                  <div
                    className="wk-nav"
                    role="tablist"
                    aria-orientation="vertical"
                    aria-label={`${group.label} sections`}
                  >
                    {items.map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        id={`wk-tab-${id}`}
                        aria-selected={tab === id}
                        aria-controls="wk-canvas"
                        tabIndex={tab === id ? 0 : -1}
                        title={label}
                        className={`wk-nav-item ${tab === id ? "is-on" : ""}`}
                        onClick={() => go(id)}
                        onKeyDown={onRailKeys}
                      >
                        <span className="wk-nav-ico" aria-hidden="true">
                          <Icon width={15} height={15} />
                        </span>
                        <span className="wk-nav-label">{label}</span>
                        {id === "keys" && keys.length ? (
                          <em className="wk-nav-count">{keys.length}</em>
                        ) : null}
                        {id === "models" && models.length ? (
                          <em className="wk-nav-count">{models.length}</em>
                        ) : null}
                        {id === "credits" && credits && !credits.unavailable ? (
                          <em className="wk-nav-count">
                            {money(credits.balance_usd ?? credits.balance ?? 0)}
                          </em>
                        ) : null}
                        {id === "referrals" && Number(referral?.invited) > 0 ? (
                          <em className="wk-nav-count">{referral.invited}</em>
                        ) : null}
                        {id === "community" ? (
                          <em
                            className={
                              communityUnread > 0 ? "wk-nav-dot" : "wk-nav-count"
                            }
                            title={
                              communityUnread > 0
                                ? `${communityUnread} unread`
                                : "live"
                            }
                          >
                            {communityUnread > 0
                              ? communityUnread > 99
                                ? "99+"
                                : communityUnread
                              : "live"}
                          </em>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="wk-rail-foot">
            <div className="wk-user">
              <span className="wk-avatar" aria-hidden="true">
                {initials(profile?.full_name || email)}
              </span>
              <span className="wk-user-meta">
                <b>{name}</b>
                <small>{profile?.org || email}</small>
              </span>
            </div>
            <div className="wk-rail-actions">
              <a className="wk-mini" href="#/console">
                Classic console
              </a>
              {isAdmin ? (
                <a className="wk-mini" href="#/admin">
                  Admin
                </a>
              ) : null}
              <button type="button" className="wk-mini" onClick={() => signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </aside>

        {/* ============================================================ main */}
        <div className="wk-main">
          <header className="wk-top">
            <nav className="wk-crumb" aria-label="Breadcrumb">
              <span>Dashboard</span>
              <span className="wk-crumb-sep" aria-hidden="true">
                /
              </span>
              <span>{activeGroup}</span>
              <span className="wk-crumb-sep" aria-hidden="true">
                /
              </span>
              <b>{active.label}</b>
            </nav>

            <div className="wk-top-actions">
              <PaletteTrigger />
              <button
                type="button"
                className="wk-icon-btn"
                onClick={load}
                title="Refresh dashboard data"
                aria-label="Refresh dashboard data"
              >
                ↻
              </button>
              <button
                type="button"
                className="wk-icon-btn"
                onClick={toggleTheme}
                title={theme === "dark" ? "Switch to light" : "Switch to dark"}
                aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
              >
                {theme === "dark" ? "☀" : "☾"}
              </button>
              <span className="wk-avatar" title={email} aria-hidden="true">
                {initials(profile?.full_name || email)}
              </span>
            </div>
          </header>

          {/* the facts you would otherwise have to open a section to read */}
          <div className="wk-pulse" aria-label="Account status">
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">gateway</span>
              <span className="wk-pulse-v" title={GATEWAY_URL}>
                {String(GATEWAY_URL || "").replace(/^https?:\/\//, "") || "not set"}
              </span>
            </div>
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">active keys</span>
              <span className="wk-pulse-v">{activeKeys}</span>
            </div>
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">balance</span>
              <span className="wk-pulse-v">
                {credits && credits.balance != null
                  ? `$${Number(credits.balance).toFixed(2)}`
                  : credits && credits.balance_usd != null
                    ? money(credits.balance_usd)
                    : "\u2014"}
              </span>
            </div>
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">requests 30d</span>
              <span className="wk-pulse-v">
                {summary && summary.requests != null
                  ? Number(summary.requests).toLocaleString()
                  : "\u2014"}
              </span>
            </div>
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">models</span>
              <span className="wk-pulse-v">{models.length || "\u2014"}</span>
            </div>
            <div className="wk-pulse-item">
              <span className="wk-pulse-l">state</span>
              <span className={loading ? "wk-pulse-v" : "wk-pulse-v is-live"}>
                {loading ? "syncing" : "live"}
              </span>
            </div>
          </div>

          <div
            className="wk-canvas"
            id="wk-canvas"
            role="tabpanel"
            aria-labelledby={`wk-tab-${tab}`}
          >
            {error ? (
              <div className="mb-4">
                <Alert
                  tone="error"
                  title="Something went wrong"
                  action={
                    <Button size="sm" variant="ghost" onClick={load}>
                      Retry
                    </Button>
                  }
                >
                  {error}
                </Alert>
              </div>
            ) : null}

            {gateLocked && tab !== "community" ? (
              <div className="wk-gatebar">
                <span className="wk-gatebar-txt">
                  <b>Gateway paused.</b> Check in to the community portal
                  {gateNeed > 0
                    ? ` and post ${gateNeed} more message${gateNeed === 1 ? "" : "s"}`
                    : ""}{" "}
                  to start serving API requests again.
                </span>
                <button
                  type="button"
                  className="wk-gatebar-cta"
                  onClick={() => setTab("community")}
                >
                  Open the portal
                </button>
              </div>
            ) : null}
            <div className="wk-panel" key={tab}>
              {loading && tab !== "community" ? (
                <div className="wk-loading">
                  <Spinner size={22} />
                  <p className="muted small">Loading {active.label.toLowerCase()}…</p>
                </div>
              ) : null}

              {!loading && tab === "overview" ? (
                <OverviewTab
                  {...shared}
                  summary={summary}
                  series={series}
                  keys={keys}
                  logs={logs}
                  models={models}
                />
              ) : null}

              {tab === "community" ? <CommunityPanel /> : null}

              {!loading && tab === "keys" ? (
                <KeysTab
                  keys={keys}
                  onCreate={onCreate}
                  onRevoke={onRevoke}
                  onRename={onRename}
                  onBudget={onBudget}
                  onIpRules={onIpRules}
                  onUseInPlayground={onUseInPlayground}
                />
              ) : null}

              {!loading && tab === "credits" ? (
                <CreditsTab
                  {...shared}
                  credits={credits}
                  ledger={ledger}
                  isAdmin={isAdmin}
                />
              ) : null}

              {!loading && tab === "referrals" ? (
                <ReferralsTab
                  referral={referral}
                  referrals={referrals}
                  link={referralLink(referral?.code)}
                  onRefresh={load}
                />
              ) : null}

              {!loading && tab === "playground" ? (
                <PlaygroundTab
                  models={models}
                  gatewayUrl={GATEWAY_URL}
                  presetKey={presetKey}
                  onRun={onRun}
                />
              ) : null}

              {!loading && tab === "models" ? (
                <ModelsTab models={models} gatewayUrl={GATEWAY_URL} onRefresh={load} />
              ) : null}

              {!loading && tab === "status" ? (
                <StatusTab
                  routes={routes}
                  days={days}
                  loading={healthLoading}
                  onRefresh={loadHealth}
                />
              ) : null}

              {!loading && tab === "logs" ? (
                <LogsTab logs={logs} onRefresh={load} />
              ) : null}

              {!loading && tab === "profile" ? (
                <ProfileTab
                  profile={profile}
                  user={user}
                  keys={keys}
                  summary={summary}
                  isAdmin={isAdmin}
                  onSave={onSaveProfile}
                  onResetPassword={() => sendPasswordReset(email)}
                  onSignOut={() => signOut()}
                />
              ) : null}

              {!loading && tab === "control" && isAdmin ? (
                <div>
                  <div className="wk-panel-head">
                    <div>
                      <span className="wk-eyebrow">control</span>
                      <h1>Admin snapshot</h1>
                      <p>
                        The numbers admin_dashboard() reports, inside this
                        dashboard. The full panel — upstreams, routing, the
                        compressor, IP rules, audit — is one click away.
                      </p>
                    </div>
                    <div className="wk-panel-head-actions">
                      <span className="wk-chip">{dashBusy ? "loading" : "live"}</span>
                      <Button size="sm" variant="ghost" onClick={loadDash} loading={dashBusy}>
                        Refresh
                      </Button>
                      <Button as="a" href="#/admin" size="sm">
                        Open admin panel
                      </Button>
                    </div>
                  </div>

                  {snapshotTiles(dash).length ? (
                    <div className="wk-kpis">
                      {snapshotTiles(dash).map((tile) => (
                        <div className="wk-kpi" key={tile.key}>
                          <span className="l">{tile.label}</span>
                          <span className="v" title={tile.value}>
                            {tile.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="wk-kpis">
                      <div className="wk-kpi">
                        <span className="l">snapshot</span>
                        <span className="v">{dashBusy ? "…" : "\u2014"}</span>
                      </div>
                    </div>
                  )}

                  <div className="wk-jump">
                    {ADMIN_JUMPS.map((j) => (
                      <a href={j.hash} key={j.hash}>
                        <b>{j.label}</b>
                        <span>{j.hint}</span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
