/* ==========================================================================
   Console
   --------------------------------------------------------------------------
   Tabbed app shell. Each tab is a presentational component in ./console/ and
   receives data + handlers as props, so this file owns all loading, error and
   mutation logic in one place.

   Tabs are addressable: #/console/keys, #/console/logs, and so on. A bare
   #/console lands on Overview. App.jsx normalises those sub-routes back to
   "#/console" for its router, so deep links and reloads keep working.
   ========================================================================== */

import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui/index.jsx";
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
  myWindowUsage,
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
import { takeDiscordResult } from "../lib/discord.js";
import { money } from "../lib/format.js";
import OverviewTab from "./console/OverviewTab.jsx";
import KeysTab from "./console/KeysTab.jsx";
import CreditsTab from "./console/CreditsTab.jsx";
import ModelsTab from "./console/ModelsTab.jsx";
import StatusTab from "./console/StatusTab.jsx";
import PlaygroundTab from "./console/PlaygroundTab.jsx";
import LogsTab from "./console/LogsTab.jsx";
import ProfileTab from "./console/ProfileTab.jsx";
import ReferralsTab from "./console/ReferralsTab.jsx";

/* Nine tabs have to sit in one row at 1180px, so the strip carries a short
   label and the full name rides along as the accessible name and tooltip.
   Every short label is a substring of its full name (WCAG 2.5.3). */
const TABS = [
  { id: "overview", label: "Overview", full: "Overview", Icon: SparkIcon },
  { id: "keys", label: "Keys", full: "API keys", Icon: KeyIcon },
  { id: "credits", label: "Credits", full: "Credits", Icon: SparkIcon },
  { id: "referrals", label: "Referrals", full: "Referrals", Icon: UserIcon },
  { id: "playground", label: "Playground", full: "Playground", Icon: BoltIcon },
  { id: "models", label: "Models", full: "Models available", Icon: ShieldIcon },
  { id: "status", label: "Status", full: "Model status", Icon: ShieldIcon },
  { id: "logs", label: "Logs", full: "Usage logs", Icon: BoltIcon },
  { id: "profile", label: "Profile", full: "Profile", Icon: UserIcon },
];

const IDS = TABS.map((t) => t.id);

function tabFromHash() {
  const raw = (window.location.hash || "").replace(/^#\/console\/?/, "").split("?")[0];
  const id = raw.replace(/\/+$/, "");
  /* "dashboard" is a friendly alias people type for the landing tab */
  if (id === "dashboard") return "overview";
  return IDS.includes(id) ? id : "overview";
}

export default function Console() {
  const { profile, user, isAdmin } = useSession();

  const [tab, setTab] = useState(tabFromHash);
  const [keys, setKeys] = useState([]);
  const [logs, setLogs] = useState([]);
  const [models, setModels] = useState([]);
  const [summary, setSummary] = useState(null);
  const [series, setSeries] = useState([]);
  const [credits, setCredits] = useState(null);
  const [windows, setWindows] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [referral, setReferral] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* v12.7: a Discord sign-in that also joined the server lands here with
     the one-time credit already paid — say so once, then the stash is gone */
  const [joinNote, setJoinNote] = useState("");

  /* health data is only fetched the first time the status tab is opened */
  const [routes, setRoutes] = useState([]);
  const [days, setDays] = useState([]);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthLoaded, setHealthLoaded] = useState(false);

  /* a freshly created key can be handed straight to the playground */
  const [presetKey, setPresetKey] = useState("");

  /* ---------------------------------------------------------------- routing */
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* The Discord callback completes at boot and stashes its outcome; a
     successful sign-in lands on #/console, so this is where the join-credit
     line is spoken. Errors route to #/login instead and never reach here. */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result?.ok && result.mode === "signin" && result.creditGranted > 0) {
      setJoinNote(
        `You joined the community server — ${money(result.creditGranted)} landed on your balance.`,
      );
    }
  }, []);

  const go = useCallback((id) => {
    const next = IDS.includes(id) ? id : "overview";
    setTab(next);
    const target = next === "overview" ? "#/console" : `#/console/${next}`;
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  /* Roving focus. role="tablist" means one tab stop for the whole strip and
     arrow keys between the tabs; the strip also scrolls on narrow screens, so
     each move pulls its tab into view. */
  const onTabKeys = useCallback(
    (e) => {
      const moves = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const at = IDS.indexOf(tab);
      const next =
        move === "first"
          ? IDS[0]
          : move === "last"
            ? IDS[IDS.length - 1]
            : IDS[(at + move + IDS.length) % IDS.length];
      go(next);
      const el = document.getElementById(`con-tab-${next}`);
      if (el) el.focus();
    },
    [tab, go]
  );

  /* Keep the active pill on screen when the tab changes from somewhere else:
     the keys tab handing off to the playground, a pasted hash, the back
     button. */
  useEffect(() => {
    const el = document.getElementById(`con-tab-${tab}`);
    if (el?.scrollIntoView) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [tab]);

  /* ------------------------------------------------------------------ load */
  const load = useCallback(async () => {
    setError("");
    try {
      const [k, l, m, s, ser, cr, win, led, ref, refs] = await Promise.all([
        listMyKeys(),
        listMyLogs(100),
        listPublicModels(),
        usageSummary(30),
        usageSeries(14),
        myCredits(),
        myWindowUsage(),
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
      setWindows(win || null);
      setLedger(led || []);
      setReferral(ref || null);
      setReferrals(refs || []);
    } catch (err) {
      setError(err.message || "Could not load your console data.");
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

  /* --------------------------------------------------------------- actions */
  /* Errors are intentionally re-thrown: KeysTab shows them inside the create
     form, which is where the person is looking. */
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

  const email = profile?.email || user?.email || "";
  const name = profile?.full_name || email.split("@")[0] || "there";

  if (loading) {
    return (
      <main id="main" className="container section gate-wait">
        <Spinner size={22} />
        <p className="muted small mt-4">Loading your console��</p>
      </main>
    );
  }

  const shared = { onRefresh: load, onGo: go, gatewayUrl: GATEWAY_URL };

  return (
    <main id="main" className="console-page">
      <div className="container">
        {/* ------------------------------------------------------- top bar */}
        <div className="con-topbar">
          <a className="brand" href="#/">
            <Logo size={34} />
            <span className="brand-name">
              Rage<span className="dim">Star</span>
            </span>
            <span className="con-brand-tag">console</span>
          </a>

          {/* the facts you otherwise had to open a tab to read */}
          <div className="con-meta-rail" aria-label="Account status">
            <div>
              <span className="l">gateway</span>
              <span className="v" title={GATEWAY_URL}>
                {String(GATEWAY_URL || "").replace(/^https?:\/\//, "") || "not set"}
              </span>
            </div>
            <div>
              <span className="l">active keys</span>
              <span className="v">{keys.filter((k) => k.status === "active").length}</span>
            </div>
            <div>
              <span className="l">balance</span>
              <span className="v">
                {credits && credits.balance != null
                  ? `$${Number(credits.balance).toFixed(2)}`
                  : "\u2014"}
              </span>
            </div>
            <div>
              <span className="l">requests 30d</span>
              <span className="v">
                {summary && summary.requests != null
                  ? Number(summary.requests).toLocaleString()
                  : "\u2014"}
              </span>
            </div>
            <div>
              <span className="l">state</span>
              <span className={loading ? "v" : "v is-live"}>{loading ? "syncing" : "live"}</span>
            </div>
          </div>

          <div className="console-user">
            <span className="hdr-avatar">{initials(profile?.full_name || email)}</span>
            <span className="hdr-user-meta">
              <b>{name}</b>
              <small>{profile?.org || email}</small>
            </span>
            {isAdmin ? (
              <Button as="a" href="#/admin" size="sm" variant="ghost">
                Admin panel
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>

        {/* ---------------------------------------------------------- tabs */}
        <nav className="con-tabs" aria-label="Console sections">
          <div className="con-tabs-track" role="tablist">
            {TABS.map(({ id, label, full, Icon }, i) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`con-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="con-panel"
                aria-label={label === full ? undefined : full}
                title={full}
                tabIndex={tab === id ? 0 : -1}
                className={`con-tab ${tab === id ? "is-on" : ""}`}
                style={{ "--m-i": i }}
                onClick={() => go(id)}
                onKeyDown={onTabKeys}
              >
                <Icon width={15} height={15} />
                <span>{label}</span>
                {id === "keys" && keys.length ? (
                  <em className="con-tab-count">{keys.length}</em>
                ) : null}
                {id === "models" && models.length ? (
                  <em className="con-tab-count">{models.length}</em>
                ) : null}
                {id === "credits" && credits && !credits.unavailable ? (
                  <em className="con-tab-count">{money(credits.balance_usd || 0)}</em>
                ) : null}
                {id === "referrals" && Number(referral?.invited) > 0 ? (
                  <em className="con-tab-count">{referral.invited}</em>
                ) : null}
              </button>
            ))}
          </div>
        </nav>

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

        {joinNote ? (
          <div className="mb-4">
            <Alert tone="ok" title="Discord join credit">
              {joinNote}
            </Alert>
          </div>
        ) : null}

        {/* --------------------------------------------------------- panel */}
        <div
          className="con-panel"
          id="con-panel"
          role="tabpanel"
          aria-labelledby={`con-tab-${tab}`}
          key={tab}
        >
          {tab === "overview" ? (
            <OverviewTab
              {...shared}
              summary={summary}
              series={series}
              keys={keys}
              logs={logs}
              models={models}
              windows={windows}
            />
          ) : null}

          {tab === "keys" ? (
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

          {tab === "credits" ? (
            <CreditsTab
              {...shared}
              credits={credits}
              ledger={ledger}
              isAdmin={isAdmin}
            />
          ) : null}

          {tab === "referrals" ? (
            <ReferralsTab
              referral={referral}
              referrals={referrals}
              link={referralLink(referral?.code)}
              onRefresh={load}
            />
          ) : null}

          {tab === "playground" ? (
            <PlaygroundTab
              models={models}
              gatewayUrl={GATEWAY_URL}
              presetKey={presetKey}
              onRun={onRun}
            />
          ) : null}

          {tab === "models" ? (
            <ModelsTab models={models} gatewayUrl={GATEWAY_URL} onRefresh={load} />
          ) : null}

          {tab === "status" ? (
            <StatusTab
              routes={routes}
              days={days}
              loading={healthLoading}
              onRefresh={loadHealth}
            />
          ) : null}

          {tab === "logs" ? <LogsTab logs={logs} onRefresh={load} /> : null}

          {tab === "profile" ? (
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
        </div>
      </div>
    </main>
  );
}
