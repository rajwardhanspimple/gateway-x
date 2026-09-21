import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui/index.jsx";
import {
  BoltIcon,
  EyeIcon,
  InfoIcon,
  KeyIcon,
  LockIcon,
  MailIcon,
  OrgIcon,
  ShieldIcon,
  SparkIcon,
  UserIcon,
} from "../components/ui/icons.jsx";
import { Logo } from "../components/brand.jsx";
import KeyWatch from "../components/KeyWatch.jsx";
import { useSession, initials, signOut } from "../lib/auth.js";
import { compact, copy, money, ms, num, relative, dateTime } from "../lib/format.js";
import {
  addUpstreamKey,
  adminDashboard,
  adjustUserCredits,
  deleteModel,
  deleteUpstream,
  deleteUpstreamKey,
  getSettings,
  listAdminModels,
  listAdminThreads,
  listAllLogs,
  listAudit,
  listCreditLedger,
  listIssuedKeys,
  listKeyChecks,
  listUpstreamKeys,
  listUpstreams,
  listUsers,
  revealUpstreamKey,
  saveModel,
  saveSettings,
  setModelAccess,
  ROLES,
  roleLabel,
  EARLY_ACCESS_UPGRADE_FILE,
  saveUpstream,
  setUpstreamKeyStatus,
  setUserCredits,
  setUserRole,
  setUserStatus,
  testUpstreamKeys,
  updateUpstreamKey,
  probeUpstreamKey,
  scanUpstreamModels,
  importScannedModels,
  pingAdminFn,
  publicIdFor,
  setUserIpRules,
} from "../lib/db.js";
import {
  accountSecurity,
  adminReferrals,
  forceSignOut,
  getReferralSettings,
  passwordResetLink,
  saveReferralSettings,
  setTempPassword,
  settleReferral,
  voidReferral,
} from "../lib/db.js";
import IpTab from "./admin/IpTab.jsx";
import FilesTab from "./admin/FilesTab.jsx";
import RoutingTab from "./admin/RoutingTab.jsx";
import CompressorTab from "./admin/CompressorTab.jsx";
import AnnouncementsTab from "./admin/AnnouncementsTab.jsx";
import DashboardTab from "./admin/DashboardTab.jsx";
import KieTab from "./admin/KieOriginalTab.jsx";
import InboxTab from "./admin/InboxTab.jsx";
import GateTab from "./admin/GateTab.jsx";
import {
  Chips,
  FilterBar,
  SearchField,
  WINDOWS,
  matchText,
  useFilters,
  withinWindow,
} from "./admin/parts.jsx";

/* Fifteen tabs in one flat strip is a wall, not a menu: every visit meant
   reading all fifteen labels to find the one you wanted. The ids are
   unchanged — #admin?tab=logs still lands on the logs — but each one now
   belongs to a group, and carries the words people actually search for. */
const GROUPS = [
  { id: "operations", label: "Operations" },
  { id: "routing", label: "Routing" },
  { id: "customers", label: "Customers" },
  { id: "money", label: "Money" },
  { id: "security", label: "Security" },
  { id: "records", label: "Records" },
  { id: "config", label: "Configuration" },
];

const TABS = [
  { id: "overview", label: "Dashboard", group: "operations", hint: "health, keys, spend, errors", keywords: "overview home status health" },
  { id: "keys", label: "Upstream keys", group: "operations", hint: "the keys you bought", keywords: "api key watch check expired rate limited" },
  { id: "upstreams", label: "Upstream APIs", group: "operations", hint: "the services you resell", keywords: "provider base url endpoint origin" },
  { id: "routing", label: "Routing & deadlines", group: "routing", hint: "failover and timeouts", keywords: "failover retry timeout hops deadline" },
  { id: "compressor", label: "Token compressors", group: "routing", hint: "shrink prompts before they cost", keywords: "compression ponytail tokens prompt savings" },
  { id: "models", label: "Model mapping", group: "routing", hint: "public id → hidden upstream id", keywords: "models pricing catalogue mapping" },
  { id: "kie", label: "KIE ORIGINAL", group: "routing", hint: "keys, model mapping, usage sheet", keywords: "kie original codex responses gpt-6-astra model mapping usage claude code codex harness dialect provider" },
  { id: "inbox", label: "Messages", group: "customers", hint: "threads members opened from the portal", keywords: "messages inbox dm direct support community portal reply threads" },
  { id: "users", label: "Users", group: "customers", hint: "accounts, roles, recovery", keywords: "accounts people signups roles password" },
  { id: "issued", label: "Issued keys", group: "customers", hint: "keys your users call with", keywords: "gateway key customer token" },
  { id: "referrals", label: "Referrals", group: "customers", hint: "invites and payouts", keywords: "referral invite bonus payout" },
  { id: "credits", label: "Credits", group: "money", hint: "balances and the ledger", keywords: "billing balance ledger topup spend" },
  { id: "ip", label: "IP limits", group: "security", hint: "allow and block lists", keywords: "ip address block allow abuse" },
  { id: "audit", label: "Audit trail", group: "security", hint: "who changed what", keywords: "audit history admin actions" },
  { id: "logs", label: "Request logs", group: "records", hint: "every call the gateway served", keywords: "requests errors latency traffic" },
  { id: "gate", label: "Gate denials", group: "records", hint: "community-gate refusals, not failures", keywords: "community gate checkin denial refused portal" },
  { id: "files", label: "File system", group: "records", hint: "uploads and attachments", keywords: "files storage uploads attachments" },
  { id: "announcements", label: "Announcements", group: "config", hint: "site-wide banners", keywords: "announcement banner news broadcast notice site" },
  { id: "settings", label: "Settings", group: "config", hint: "brand, signup, retention", keywords: "settings config brand signup policy" },
];

const KEY_STATES = ["unknown", "working", "failing", "rate_limited", "expired", "disabled"];

/* The panel rides the same shell as the member dashboard, so it shares the two
   things that shell remembers: whether the rail is collapsed, and the theme.
   Same storage keys, same event — collapse the rail in one place and it is
   collapsed in the other. */
const RAIL_KEY = "ragestar-dashboard-rail";
const THEME_KEY = "ragestar-theme";

const TAB_ICONS = {
  overview: SparkIcon,
  keys: KeyIcon,
  upstreams: OrgIcon,
  routing: BoltIcon,
  compressor: BoltIcon,
  models: OrgIcon,
  kie: SparkIcon,
  inbox: MailIcon,
  users: UserIcon,
  issued: KeyIcon,
  referrals: UserIcon,
  credits: SparkIcon,
  ip: LockIcon,
  audit: EyeIcon,
  logs: InfoIcon,
  gate: LockIcon,
  files: OrgIcon,
  announcements: InfoIcon,
  settings: ShieldIcon,
};

/* #/admin/<section> is a real address now. These are the words people type or
   link with when they mean a section but not its id. */
const ALIASES = {
  dashboard: "overview",
  home: "overview",
  messages: "inbox",
  dm: "inbox",
  dms: "inbox",
  support: "inbox",
  community: "inbox",
  accounts: "users",
  people: "users",
  requests: "logs",
  denied: "gate",
  denials: "gate",
  checkin: "gate",
  billing: "credits",
  config: "settings",
};

function tabFromHash() {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const seg = (path.split("/")[1] || "").toLowerCase();
  /* the old address was #/admin?tab=logs — those links still land */
  const legacy = ((query || "").match(/tab=([\w-]+)/) || [])[1] || "";
  const want = (seg || legacy || "overview").toLowerCase();
  const id = ALIASES[want] || want;
  return TABS.some((t) => t.id === id) ? id : "overview";
}

function St({ value }) {
  return <span className={`st st-${value || "unknown"}`}>{String(value || "unknown").replace(/_/g, " ")}</span>;
}

function L({ children, req }) {
  return (
    <span className="adm-label">
      {children}
      {req ? <span className="req"> *</span> : null}
    </span>
  );
}

/* One box that searches the panel itself. Fifteen sections is past the point
   where scanning is faster than typing, and "where do I set the failover
   limit" is a question about the panel, not about the data. */
function AdminTopbar({ current, onJump, onRefresh, children }) {
  const [q, setQ] = useState("");

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return TABS.filter((t) =>
      `${t.label} ${t.hint} ${t.keywords} ${t.group}`.toLowerCase().includes(needle),
    ).slice(0, 6);
  }, [q]);

  const jump = (id) => {
    setQ("");
    onJump(id);
  };

  return (
    <div className="ap-topbar">
      <div className="ap-jump">
        <input
          type="search"
          className="input ap-search"
          value={q}
          placeholder="Jump to a section — try “failover”, “ponytail”, “refunds”…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits.length) jump(hits[0].id);
            if (e.key === "Escape") setQ("");
          }}
        />
        {hits.length ? (
          <ul className="ap-jump-list">
            {hits.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => jump(t.id)}>
                  <b>{t.label}</b>
                  <span className="ap-muted ap-xs">{t.hint}</span>
                  <small>{GROUPS.find((g) => g.id === t.group)?.label}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className="ap-muted ap-xs">
        {GROUPS.find((g) => g.id === TABS.find((t) => t.id === current)?.group)?.label || "Admin"}
      </span>
      {children}
      {onRefresh ? (
        <button type="button" className="ap-chip" onClick={onRefresh}>
          Refresh
        </button>
      ) : null}
    </div>
  );
}

const EMPTY_UPSTREAM = {
  name: "",
  slug: "",
  base_url: "",
  chat_path: "/chat/completions",
  models_path: "/models",
  health_path: "",
  auth_scheme: "bearer",
  auth_header: "Authorization",
  auth_query_arg: "",
  priority: 100,
  timeout_ms: 60000,
  is_active: true,
  extra_headers: "{}",
  notes: "",
};

const EMPTY_MODEL = {
  public_id: "",
  display_name: "",
  upstream_id: "",
  upstream_model_id: "",
  description: "",
  context_window: "",
  max_output_tokens: "",
  price_in_per_m: "",
  price_out_per_m: "",
  capabilities: "",
  status: "active",
  sort_order: 100,
  is_active: true,
  /* v12.4: "public" or "early_access". */
  access_tier: "public",
  access_note: "",
};

/* The two tables that actually get long. Predicates live at module scope so
   the count in the filter bar is produced by the same function that draws the
   rows — a bar reading “12 of 400” above a table showing something else is
   worse than no bar at all. */
function filterLogs(rows, f) {
  return (rows || []).filter(
    (l) =>
      withinWindow(l.created_at, f.window) &&
      (f.state === "all" || (f.state === "errors" ? !l.ok : !!l.ok)) &&
      matchText(f.q, l.model_public_id, l.request_id, l.error_code, l.status_code, l.user_email, l.user_name),
  );
}

function filterAudit(rows, f) {
  return (rows || []).filter(
    (a) =>
      withinWindow(a.created_at, f.window) &&
      matchText(f.q, a.actor_email, a.action, a.entity, a.entity_id),
  );
}

export default function Admin({ bare = false, setNav = null } = {}) {
  const { profile, user } = useSession();
  const [tab, setTabState] = useState(tabFromHash);
  const [threads, setThreads] = useState([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch (e) {
      return false;
    }
  });
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || "dark",
  );

  /* every jump writes the address, so a section can be linked, bookmarked and
     reached with the back button */
  const setTab = useCallback((id) => {
    setTabState(id);
    const next = `#/admin/${id}`;
    if (window.location.hash !== next) window.location.hash = next;
  }, []);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const [dash, setDash] = useState(null);
  const [upstreams, setUpstreams] = useState([]);
  const [upKeys, setUpKeys] = useState([]);
  const [models, setModels] = useState([]);
  const [users, setUsers] = useState([]);
  const [issued, setIssued] = useState([]);
  const [logs, setLogs] = useState([]);
  const [audit, setAudit] = useState([]);
  const [settings, setSettings] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [creditForm, setCreditForm] = useState({ user_id: "", mode: "add", amount: "", note: "" });
  const [refRows, setRefRows] = useState([]);
  const [refSettings, setRefSettings] = useState(null);
  /* the account-recovery panel, open for one user at a time */
  const [recover, setRecover] = useState(null);

  const [upForm, setUpForm] = useState(EMPTY_UPSTREAM);
  const [keyForm, setKeyForm] = useState({ upstream_id: "", label: "", api_key: "", weight: 100, expires_at: "", notes: "" });
  const [modelForm, setModelForm] = useState(EMPTY_MODEL);
  const [revealed, setRevealed] = useState({});
  const [checks, setChecks] = useState({});
  const [testOut, setTestOut] = useState(null);

  /* Remembered per tab: coming back to the logs should show the view you
     left, not a reset. */
  const [logFilter, setLogFilter, resetLogFilter, logFilterDirty] = useFilters("rs-adm-logs", {
    q: "",
    state: "all",
    window: "24h",
  });
  const [auditFilter, setAuditFilter, resetAuditFilter, auditFilterDirty] = useFilters(
    "rs-adm-audit",
    { q: "", window: "7d" },
  );

  // result of testing a pasted key that is not stored yet
  const [probeOut, setProbeOut] = useState(null);
  const [storeAnyway, setStoreAnyway] = useState(false);

  // automatic model discovery
  const [scan, setScan] = useState({
    upstream_id: "",
    api_key: "",
    prefix: "",
    markup: 1,
    fallbackIn: "",
    fallbackOut: "",
    status: "active",
    overwrite: false,
  });
  const [scanOut, setScanOut] = useState(null);
  const [scanSel, setScanSel] = useState({});
  const [scanFilter, setScanFilter] = useState("");

  const scanModels = scanOut?.models ?? [];
  const scanNeedle = scanFilter.trim().toLowerCase();
  const visibleScan = scanNeedle
    ? scanModels.filter((m) => `${m.id} ${m.display_name}`.toLowerCase().includes(scanNeedle))
    : scanModels;
  const selectedScanCount = scanModels.filter((m) => scanSel[m.id]).length;

  const flash = (msg) => {
    setOk(msg);
    setError("");
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setOk(""), 4000);
  };

  /* ------------------------------------------------------ account recovery */
  /* There is deliberately no "show password" action. Supabase Auth keeps a
     bcrypt hash in auth.users.encrypted_password, so the original text does
     not exist anywhere to be read back — not by an admin, not by the service
     role, not in SQL. These three cover every real lockout instead, and each
     one writes an audit_logs row naming the admin who ran it. */
  const openRecover = async (u) => {
    setRecover({ user: u, security: null, link: "", temp: "", err: "" });
    try {
      const sec = await accountSecurity(u.id);
      setRecover((r) => (r?.user?.id === u.id ? { ...r, security: sec } : r));
    } catch (e) {
      setRecover((r) => (r?.user?.id === u.id ? { ...r, err: e.message } : r));
    }
  };

  const runRecover = async (kind) => {
    const u = recover?.user;
    if (!u) return;
    setBusy(`rec-${kind}`);
    setRecover((r) => (r ? { ...r, err: "" } : r));
    try {
      if (kind === "link") {
        const out = await passwordResetLink(u.id);
        setRecover((r) => (r ? { ...r, link: out.link, temp: "" } : r));
        flash("One-time recovery link created.");
      } else if (kind === "temp") {
        const out = await setTempPassword(u.id);
        setRecover((r) => (r ? { ...r, temp: out.password, link: "" } : r));
        flash("Temporary password set — all sessions were signed out.");
      } else {
        await forceSignOut(u.id);
        flash("Every session for that account was ended.");
        const sec = await accountSecurity(u.id).catch(() => null);
        setRecover((r) => (r ? { ...r, security: sec ?? r.security } : r));
      }
    } catch (e) {
      setRecover((r) => (r ? { ...r, err: e.message } : r));
    } finally {
      setBusy("");
    }
  };

  const submitReferralSettings = async (e) => {
    e.preventDefault();
    setBusy("refset");
    try {
      await saveReferralSettings(refSettings || {});
      flash("Referral settings saved.");
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const loadAll = useCallback(async () => {
    setError("");
    try {
      const [d, u, k, m, us, iss, lg, au, st, cl, rf, rs, th] = await Promise.all([
        adminDashboard(),
        listUpstreams(),
        listUpstreamKeys(),
        listAdminModels(),
        listUsers(),
        listIssuedKeys(100),
        listAllLogs(100),
        listAudit(60),
        getSettings(),
        listCreditLedger(100),
        adminReferrals(),
        getReferralSettings(),
        listAdminThreads(),
      ]);
      setDash(d);
      setUpstreams(u || []);
      setUpKeys(k || []);
      setModels(m || []);
      setUsers(us || []);
      setIssued(iss || []);
      setLogs(lg || []);
      setAudit(au || []);
      setSettings(st || null);
      setLedger(cl || []);
      setRefRows(rf || []);
      setRefSettings(rs || null);
      setThreads(th || []);
    } catch (err) {
      setError(err.message || "Could not load admin data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  /* back, forward, and links into a section */
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? "collapsed" : "open");
    } catch (e) {}
  }, [collapsed]);

  /* theme lives on <html>, shared with every other screen. Bare mode (inside
     the RageStar shell) never touches it ? the kit is light-only by design. */
  useEffect(() => {
    if (bare) return;
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const onTheme = (e) => {
      const next = e.detail || document.documentElement.getAttribute("data-theme");
      if (next) setTheme(next);
    };
    window.addEventListener("ragestar-theme-change", onTheme);
    return () => window.removeEventListener("ragestar-theme-change", onTheme);
  }, []);

  /* Derived rows for the logs and audit tables.

     These two useMemo calls used to live further down the file, *below* the
     `if (loading) return <spinner/>` early return. That meant the first render
     (loading === true) ran N hooks and the next render (loading === false) ran
     N + 2, and React throws "Rendered more hooks than during the previous
     render." Hooks have to be called in the same order, and the same number of
     times, on every single render — so they belong up here with the rest of
     them, above any early return. */
  const shownLogs = useMemo(() => filterLogs(logs, logFilter), [logs, logFilter]);
  const shownAudit = useMemo(() => filterAudit(audit, auditFilter), [audit, auditFilter]);

  /* -------------------------------------------------------------- actions */

  const submitUpstream = async (e) => {
    e.preventDefault();
    setBusy("upstream");
    try {
      await saveUpstream(upForm);
      setUpForm(EMPTY_UPSTREAM);
      setUpstreams(await listUpstreams());
      flash("Upstream saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const editUpstream = (row) => {
    setUpForm({
      ...row,
      extra_headers: JSON.stringify(row.extra_headers || {}, null, 0),
      auth_query_arg: row.auth_query_arg || "",
      health_path: row.health_path || "",
      notes: row.notes || "",
    });
    setTab("upstreams");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const removeUpstream = async (id) => {
    if (!window.confirm("Delete this upstream? Its keys and model mappings go with it.")) return;
    try {
      await deleteUpstream(id);
      await loadAll();
      flash("Upstream deleted.");
    } catch (err) {
      setError(err.message);
    }
  };

  /** Tests a pasted key against the upstream. Writes nothing to the database. */
  const probeKey = async () => {
    setError("");
    setProbeOut(null);
    setBusy("probe");
    try {
      const res = await probeUpstreamKey({
        upstream_id: keyForm.upstream_id,
        api_key: keyForm.api_key,
        label: keyForm.label,
      });
      setProbeOut(res);
      if (res.ok) {
        flash(`Key works — ${res.model_count ?? "?"} models visible in ${ms(res.latency_ms)}.`);
      } else {
        setError(
          `The upstream rejected this key (${res.status_code || "no response"}). ${res.hint || res.message || ""}`,
        );
      }
      return res;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  };

  const submitKey = async (e) => {
    e.preventDefault();
    setError("");
    setBusy("key");
    try {
      // Always test first — a dead key sitting in the rotation costs real requests.
      const probe = await probeUpstreamKey({
        upstream_id: keyForm.upstream_id,
        api_key: keyForm.api_key,
        label: keyForm.label,
      });
      setProbeOut(probe);
      if (!probe.ok && !storeAnyway) {
        setError(
          `Not stored — the upstream rejected this key (${probe.status_code || "no response"}). ` +
            `${probe.hint || probe.message || ""} Tick “store it even if the test fails” to keep it anyway.`,
        );
        return;
      }
      await addUpstreamKey(keyForm);
      setKeyForm({ upstream_id: keyForm.upstream_id, label: "", api_key: "", weight: 100, expires_at: "", notes: "" });
      setUpKeys(await listUpstreamKeys());
      setProbeOut(null);
      flash(
        probe.ok
          ? `Key tested and stored — ${probe.model_count ?? "?"} models reachable.`
          : "Key stored, but it failed its test. It will stay out of rotation until it passes.",
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  /** Proves whether the key-check function is deployed and reachable at all. */
  const diagnose = async () => {
    setBusy("diagnose");
    try {
      const res = await pingAdminFn();
      setError("");
      flash(`Key-check function answered in ${res.elapsed} ms (v${res.version || "?"}). The connection is fine.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  /* ------------------------------------------------- automatic model scan */

  const runScan = async () => {
    setError("");
    setScanOut(null);
    setScanSel({});
    setBusy("scan");
    try {
      const res = await scanUpstreamModels({
        upstream_id: scan.upstream_id,
        api_key: scan.api_key,
      });
      setScanOut(res);
      if (!res.ok) {
        setError(res.message || "The upstream would not list its models.");
        return;
      }
      setScanSel(Object.fromEntries((res.models || []).map((m) => [m.id, true])));
      flash(`Found ${res.count} model${res.count === 1 ? "" : "s"} on ${res.upstream}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const importSelected = async () => {
    const chosen = scanModels.filter((m) => scanSel[m.id]);
    setError("");
    setBusy("import");
    try {
      const res = await importScannedModels({
        upstream_id: scan.upstream_id,
        models: chosen,
        prefix: scan.prefix,
        markup: scan.markup,
        fallbackPriceIn: scan.fallbackIn,
        fallbackPriceOut: scan.fallbackOut,
        status: scan.status,
        overwrite: scan.overwrite,
      });
      setModels(await listAdminModels());
      flash(
        `Imported ${res.written} of ${res.requested} models` +
          (res.skipped ? ` — ${res.skipped} already existed.` : "."),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const runTest = async (body, label) => {
    setBusy(`test:${label}`);
    setTestOut(null);
    try {
      const res = await testUpstreamKeys(body);
      setTestOut(res);
      setUpKeys(await listUpstreamKeys());
      setDash(await adminDashboard());
      flash(`Checked ${res.checked} key${res.checked === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  /* One silent pass over every stored key, driven by the KeyWatch panel's
     15-second beat. Deliberately quieter than runTest: no busy spinner and no
     flash message, because it fires on its own and would otherwise strobe the
     page every quarter minute. The rows and the dashboard still refresh. */
  const autoTest = useCallback(async () => {
    const res = await testUpstreamKeys({});
    setTestOut(res);
    const [keys, d] = await Promise.all([
      listUpstreamKeys(),
      adminDashboard().catch(() => null),
    ]);
    setUpKeys(keys || []);
    if (d) setDash(d);
    return res;
  }, []);

  const forceStatus = async (id, status) => {
    try {
      await setUpstreamKeyStatus(id, status, "set manually from admin panel");
      setUpKeys(await listUpstreamKeys());
      setDash(await adminDashboard());
      flash(`Key marked ${status.replace(/_/g, " ")}.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleKeyActive = async (row) => {
    try {
      await updateUpstreamKey(row.id, { is_active: !row.is_active });
      setUpKeys(await listUpstreamKeys());
      flash(row.is_active ? "Key paused." : "Key resumed.");
    } catch (err) {
      setError(err.message);
    }
  };

  const reveal = async (id) => {
    try {
      if (revealed[id]) {
        setRevealed((s) => ({ ...s, [id]: null }));
        return;
      }
      const value = await revealUpstreamKey(id);
      setRevealed((s) => ({ ...s, [id]: value }));
      setAudit(await listAudit(60));
    } catch (err) {
      setError(err.message);
    }
  };

  const history = async (id) => {
    try {
      if (checks[id]) {
        setChecks((s) => ({ ...s, [id]: null }));
        return;
      }
      const rows = await listKeyChecks(id, 8);
      setChecks((s) => ({ ...s, [id]: rows ?? [] }));
    } catch (err) {
      setError(err.message);
    }
  };

  const removeKey = async (id) => {
    if (!window.confirm("Permanently delete this upstream key?")) return;
    try {
      await deleteUpstreamKey(id);
      setUpKeys(await listUpstreamKeys());
      flash("Key deleted.");
    } catch (err) {
      setError(err.message);
    }
  };

  const submitModel = async (e) => {
    e.preventDefault();
    setBusy("model");
    try {
      await saveModel(modelForm);
      setModelForm(EMPTY_MODEL);
      setModels(await listAdminModels());
      flash("Model mapping saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const editModel = (row) => {
    setModelForm({
      ...row,
      capabilities: (row.capabilities || []).join(", "),
      description: row.description || "",
      context_window: row.context_window ?? "",
      max_output_tokens: row.max_output_tokens ?? "",
      access_tier: row.access_tier || "public",
      access_note: row.access_note || "",
    });
    setTab("models");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* One click moves a published model behind early access, or hands it back
     to everyone. The same thing the Access select in the form does. */
  const toggleModelAccess = async (row) => {
    const next = row.access_tier === "early_access" ? "public" : "early_access";
    try {
      await setModelAccess(row.id, next);
      setModels(await listAdminModels());
      flash(
        next === "early_access"
          ? `${row.public_id} is early access only.`
          : `${row.public_id} is open to everyone again.`,
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const removeModel = async (id) => {
    if (!window.confirm("Delete this model mapping?")) return;
    try {
      await deleteModel(id);
      setModels(await listAdminModels());
      flash("Model deleted.");
    } catch (err) {
      setError(err.message);
    }
  };

  /* Credit movements always go through the audited RPCs — the balance column
     itself is locked down by a trigger, so there is no way to fudge it. */
  const submitCredit = async (e) => {
    e.preventDefault();
    const amount = Number(creditForm.amount);
    if (!creditForm.user_id) {
      setError("Pick an account first.");
      return;
    }
    if (!Number.isFinite(amount) || (creditForm.mode !== "set" && amount === 0)) {
      setError("Enter an amount in USD.");
      return;
    }
    setBusy("credit");
    try {
      if (creditForm.mode === "set") {
        await setUserCredits(creditForm.user_id, amount, creditForm.note || null);
      } else {
        const delta = creditForm.mode === "deduct" ? -Math.abs(amount) : Math.abs(amount);
        await adjustUserCredits(creditForm.user_id, delta, creditForm.note || null);
      }
      const [us, cl] = await Promise.all([listUsers(), listCreditLedger(100)]);
      setUsers(us || []);
      setLedger(cl || []);
      setCreditForm((f) => ({ ...f, amount: "", note: "" }));
      flash(creditForm.mode === "set" ? "Balance set." : "Credit updated.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const saveSet = async (patch, msg) => {
    try {
      await saveSettings(patch);
      setSettings(await getSettings());
      flash(msg || "Settings saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  /* Everything below must run on EVERY render — hooks and their inputs sit
     above the `if (loading)` return. This block was previously nested inside
     the if, so the first render (loading === true) ran two hooks more than
     the second (loading === false), and React aborted with "Rendered fewer
     hooks than expected". Same rule, opposite direction from the v11.0.0
     bug in HOOK-ERROR-REPORT.md: one hook block at the top, first `return`
     after it. */
  const email = profile?.email || user?.email || "";

  const counts = {
    upstreams: upstreams.length,
    keys: upKeys.length,
    models: models.length,
    users: users.length,
    issued: issued.length,
    logs: logs.length,
    audit: audit.length,
    inbox: threads.length,
  };

  const unread = threads.reduce((n, t) => n + (Number(t.unread) || 0), 0);
  const activeTab = TABS.find((t) => t.id === tab) || TABS[0];
  const activeGroup = GROUPS.find((g) => g.id === activeTab.group) || GROUPS[0];

  /* Bare mode (the RageStar admin shell owns the rail/topbar): hand the grouped
     nav, the pulse numbers and the jump handler up, so the parent renders the
     chrome and this component renders only the section content. The payload is
     memoized on its scalar deps so the effect cannot re-render in a loop. */
  const navPayload = useMemo(
    () => ({
      tab,
      groups: GROUPS,
      tabs: TABS,
      counts,
      unread,
      activeGroup,
      activeTab,
      onJump: setTab,
      onRefresh: loadAll,
      dash,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, unread, dash, counts.upstreams, counts.keys, counts.models, counts.users, counts.issued, counts.logs, counts.audit, counts.inbox, setTab, loadAll],
  );
  useEffect(() => {
    if (bare && setNav) setNav(navPayload);
  }, [bare, setNav, navPayload]);

  if (loading) {
    return (
      <main id="main" className="container section gate-wait">
        <Spinner size={22} />
        <p className="muted small mt-4">Loading admin panel…</p>
      </main>
    );
  }

  /* app_settings only has the credit columns once upgrade-v5.4.sql has run */
  const hasCredits = settings ? settings.credits_enabled !== undefined : false;
  const hasWindows = settings ? settings.five_hour_limit_usd !== undefined : false;
  /* v12.7: the join-credit setting exists once the announcements migration ran */
  const hasDiscord = settings ? settings.discord_join_credit_usd !== undefined : false;
  /* v12.9: the Discord API gate switch exists once the gate migration ran */
  const hasDiscordGate = settings ? settings.discord_required !== undefined : false;
  const creditTotals = users.reduce(
    (a, u) => ({
      balance: a.balance + Number(u.credit_balance_usd || 0),
      added: a.added + Number(u.credits_added_usd || 0),
      used: a.used + Number(u.credits_used_usd || 0),
    }),
    { balance: 0, added: 0, used: 0 },
  );

  const refreshCredits = async (msg) => {
    try {
      const [us, cl] = await Promise.all([listUsers(), listCreditLedger(100)]);
      setUsers(us || []);
      setLedger(cl || []);
      if (msg) flash(msg);
    } catch (err) {
      setError(err.message);
    }
  };


  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    window.dispatchEvent(new CustomEvent("ragestar-theme-change", { detail: next }));
  };

  /* Same shell as the member dashboard: one rail, one sticky top bar, one
     canvas. The panel used to be a 232px nav inside a flat container, which is
     why the two halves of the product never felt related. Every section, id
     and handler below is untouched — only the frame changed. */
  const adminBody = (
    <div className={bare ? "adm-body ap" : "wk-panel adm-body ap"} key={tab}>


          {error ? (
            <Alert
              tone="error"
              title="Action failed"
              action={
                <>
                  <Button size="sm" variant="ghost" loading={busy === "diagnose"} onClick={diagnose}>Diagnose</Button>
                  <Button size="sm" variant="ghost" onClick={loadAll}>Reload</Button>
                </>
              }
            >
              <span style={{ whiteSpace: "pre-wrap" }}>{error}</span>
            </Alert>
          ) : null}
          {ok ? <Alert tone="ok" title="Done">{ok}</Alert> : null}

          {/* ================================================== OVERVIEW === */}
          {tab === "overview" ? (
            <>
              <div className="adm-head">
                <div>
                  <h1>Overview</h1>
                  <p>Everything the gateway knows, straight from your Supabase project.</p>
                </div>
                <div className="adm-head-actions">
                  <Button size="sm" variant="ghost" onClick={loadAll}>Refresh</Button>
                  <Button size="sm" variant="primary" loading={busy === "test:all"} onClick={() => runTest({}, "all")}>
                    Test all upstream keys
                  </Button>
                </div>
              </div>

              <DashboardTab
                dash={dash}
                upstreams={upstreams}
                upKeys={upKeys}
                models={models}
                users={users}
                logs={logs}
                audit={audit}
                busy={busy}
                onRefresh={loadAll}
                onTest={runTest}
                onAutoTest={autoTest}
                onJump={setTab}
              />

              {testOut?.results?.length ? (
                <div className="adm-card">
                  <h3>Last health check</h3>
                  <div className="adm-table-wrap">
                    <table className="adm-table">
                      <thead><tr><th>Key</th><th>Upstream</th><th>Result</th><th className="num">HTTP</th><th className="num">Latency</th><th>Message</th></tr></thead>
                      <tbody>
                        {testOut.results.map((r) => (
                          <tr key={r.key_id}>
                            <td>{r.label}</td>
                            <td className="faint">{r.upstream}</td>
                            <td><St value={r.state} /></td>
                            <td className="num">{r.status_code ?? "—"}</td>
                            <td className="num">{r.latency_ms ? ms(r.latency_ms) : "—"}</td>
                            <td className="faint xs">{r.message || (r.ok ? "reachable" : "—")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {upstreams.length === 0 ? (
                <div className="adm-empty">
                  <b>Start by adding the API you want to resell</b>
                  Add the upstream base URL, paste the API keys it gave you, then map a
                  public model id your users will call.
                  <div><Button size="sm" variant="primary" onClick={() => setTab("upstreams")}>Add upstream API</Button></div>
                </div>
              ) : null}
            </>
          ) : null}

          {/* ================================================= UPSTREAMS === */}
          {tab === "upstreams" ? (
            <>
              <div className="adm-head">
                <div>
                  <h1>Upstream APIs</h1>
                  <p>
                    The origin services you are re-selling. Base URLs and paths are
                    stored here and never sent to the browser of an end user.
                  </p>
                </div>
              </div>

              <form className="adm-card" onSubmit={submitUpstream}>
                <h3>{upForm.id ? "Edit upstream" : "Add an upstream API"}</h3>
                <p className="sub">Anything OpenAI-compatible works out of the box; other shapes can use custom paths and headers.</p>
                <div className="adm-grid">
                  <div>
                    <L req>Display name</L>
                    <input className="adm-input" required value={upForm.name} onChange={(e) => setUpForm({ ...upForm, name: e.target.value })} placeholder="Origin provider" />
                  </div>
                  <div>
                    <L>Slug</L>
                    <input className="adm-input" value={upForm.slug} onChange={(e) => setUpForm({ ...upForm, slug: e.target.value })} placeholder="auto from name" />
                  </div>
                  <div>
                    <L req>Base URL</L>
                    <input className="adm-input" required type="url" value={upForm.base_url} onChange={(e) => setUpForm({ ...upForm, base_url: e.target.value })} placeholder="https://api.example.com/v1" />
                  </div>
                  <div>
                    <L>Chat path</L>
                    <input className="adm-input" value={upForm.chat_path} onChange={(e) => setUpForm({ ...upForm, chat_path: e.target.value })} />
                  </div>
                  <div>
                    <L>Models path</L>
                    <input className="adm-input" value={upForm.models_path} onChange={(e) => setUpForm({ ...upForm, models_path: e.target.value })} />
                  </div>
                  <div>
                    <L>Health path</L>
                    <input className="adm-input" value={upForm.health_path} onChange={(e) => setUpForm({ ...upForm, health_path: e.target.value })} placeholder="defaults to models path" />
                  </div>
                  <div>
                    <L>Auth scheme</L>
                    <select className="adm-select" value={upForm.auth_scheme} onChange={(e) => setUpForm({ ...upForm, auth_scheme: e.target.value })}>
                      <option value="bearer">Authorization: Bearer KEY</option>
                      <option value="x-api-key">x-api-key: KEY</option>
                      <option value="api-key">api-key: KEY</option>
                      <option value="header">custom header</option>
                      <option value="query">query string</option>
                    </select>
                  </div>
                  <div>
                    <L>Auth header name</L>
                    <input className="adm-input" value={upForm.auth_header} onChange={(e) => setUpForm({ ...upForm, auth_header: e.target.value })} placeholder="Authorization" />
                  </div>
                  <div>
                    <L>Auth query arg</L>
                    <input className="adm-input" value={upForm.auth_query_arg} onChange={(e) => setUpForm({ ...upForm, auth_query_arg: e.target.value })} placeholder="key" />
                  </div>
                  <div>
                    <L>Priority</L>
                    <input className="adm-input" type="number" value={upForm.priority} onChange={(e) => setUpForm({ ...upForm, priority: e.target.value })} />
                  </div>
                  <div>
                    <L>Timeout (ms)</L>
                    <input className="adm-input" type="number" value={upForm.timeout_ms} onChange={(e) => setUpForm({ ...upForm, timeout_ms: e.target.value })} />
                  </div>
                  <div>
                    <L>Active</L>
                    <select className="adm-select" value={upForm.is_active ? "yes" : "no"} onChange={(e) => setUpForm({ ...upForm, is_active: e.target.value === "yes" })}>
                      <option value="yes">Yes — eligible for routing</option>
                      <option value="no">No — paused</option>
                    </select>
                  </div>
                </div>
                <div className="mt-4">
                  <L>Extra headers (JSON)</L>
                  <textarea className="adm-textarea" value={upForm.extra_headers} onChange={(e) => setUpForm({ ...upForm, extra_headers: e.target.value })} placeholder='{"HTTP-Referer":"https://yourapp.com"}' />
                </div>
                <div className="mt-4">
                  <L>Private notes</L>
                  <input className="adm-input" value={upForm.notes} onChange={(e) => setUpForm({ ...upForm, notes: e.target.value })} placeholder="only visible to admins" />
                </div>
                <div className="adm-form-actions">
                  <Button type="submit" variant="primary" size="sm" loading={busy === "upstream"}>
                    {upForm.id ? "Save changes" : "Add upstream"}
                  </Button>
                  {upForm.id ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setUpForm(EMPTY_UPSTREAM)}>Cancel</Button>
                  ) : null}
                </div>
              </form>

              {upstreams.length === 0 ? (
                <div className="adm-empty"><b>No upstreams yet</b>Add the first origin API above.</div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>Name</th><th>Base URL</th><th>Auth</th><th className="num">Priority</th><th className="num">Keys</th><th>State</th><th /></tr></thead>
                    <tbody>
                      {upstreams.map((u) => (
                        <tr key={u.id}>
                          <td><b>{u.name}</b><div className="faint xs mono">{u.slug}</div></td>
                          <td className="mono">{u.base_url}</td>
                          <td className="faint xs">{u.auth_scheme}</td>
                          <td className="num">{u.priority}</td>
                          <td className="num">{upKeys.filter((k) => k.upstream_id === u.id).length}</td>
                          <td><St value={u.is_active ? "active" : "disabled"} /></td>
                          <td>
                            <div className="acts">
                              <Button size="sm" variant="ghost" onClick={() => editUpstream(u)}>Edit</Button>
                              <Button size="sm" variant="ghost" loading={busy === `test:${u.id}`} onClick={() => runTest({ upstream_id: u.id }, u.id)}>Test keys</Button>
                              <Button size="sm" variant="danger" onClick={() => removeUpstream(u.id)}>Delete</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ====================================================== KEYS === */}
          {tab === "keys" ? (
            <>
              <div className="adm-head">
                <div>
                  <h1>Upstream keys</h1>
                  <p>
                    The API keys the origin website gave you. Stored once, masked in
                    every read, and each one carries a live working / failing state.
                  </p>
                </div>
                <div className="adm-head-actions">
                  <Button size="sm" variant="ghost" loading={busy === "diagnose"} onClick={diagnose}>Check connection</Button>
                  <Button size="sm" variant="primary" loading={busy === "test:all"} onClick={() => runTest({}, "all")}>Test every key</Button>
                </div>
              </div>

              {/* the 15-second watcher: same check as the button above, on a beat */}
              <KeyWatch onRun={autoTest} defaultSeconds={15} />

              <form className="adm-card" onSubmit={submitKey}>
                <h3><KeyIcon width={15} height={15} /> Add an upstream key</h3>
                <p className="sub">Paste the raw key. It is written straight to the database and never rendered back in full unless you explicitly reveal it.</p>
                <div className="adm-grid">
                  <div>
                    <L req>Upstream</L>
                    <select className="adm-select" required value={keyForm.upstream_id} onChange={(e) => setKeyForm({ ...keyForm, upstream_id: e.target.value })}>
                      <option value="">Select an upstream…</option>
                      {upstreams.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                    </select>
                  </div>
                  <div>
                    <L>Label</L>
                    <input className="adm-input" value={keyForm.label} onChange={(e) => setKeyForm({ ...keyForm, label: e.target.value })} placeholder="account-1" />
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <L req>API key</L>
                    <input className="adm-input mono" required type="password" autoComplete="off" value={keyForm.api_key} onChange={(e) => setKeyForm({ ...keyForm, api_key: e.target.value })} placeholder="sk-…" />
                  </div>
                  <div>
                    <L>Weight</L>
                    <input className="adm-input" type="number" value={keyForm.weight} onChange={(e) => setKeyForm({ ...keyForm, weight: e.target.value })} />
                  </div>
                  <div>
                    <L>Expires</L>
                    <input className="adm-input" type="date" value={keyForm.expires_at} onChange={(e) => setKeyForm({ ...keyForm, expires_at: e.target.value })} />
                  </div>
                  <div>
                    <L>Notes</L>
                    <input className="adm-input" value={keyForm.notes} onChange={(e) => setKeyForm({ ...keyForm, notes: e.target.value })} placeholder="where this key came from" />
                  </div>
                </div>
                <div className="adm-form-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    loading={busy === "probe"}
                    disabled={!keyForm.upstream_id || !keyForm.api_key}
                    onClick={probeKey}
                  >
                    Test key only
                  </Button>
                  <Button type="submit" variant="primary" size="sm" loading={busy === "key"} disabled={!upstreams.length}>Test &amp; store key</Button>
                  <label className="faint xs" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={storeAnyway} onChange={(e) => setStoreAnyway(e.target.checked)} />
                    store it even if the test fails
                  </label>
                  {!upstreams.length ? <span className="faint xs">Add an upstream first.</span> : null}
                </div>

                {probeOut ? (
                  <div className="reveal-box" style={{ marginTop: 12, display: "block" }}>
                    <b>{probeOut.ok ? "Key works" : "Key rejected"}</b>
                    <div className="faint xs" style={{ marginTop: 4 }}>
                      {probeOut.upstream} · {probeOut.endpoint} · HTTP {probeOut.status_code || "—"} · {ms(probeOut.latency_ms)}
                      {probeOut.ok && probeOut.model_count != null ? ` · ${probeOut.model_count} models visible` : ""}
                    </div>
                    {probeOut.message ? (
                      <div className="xs mono" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{probeOut.message}</div>
                    ) : null}
                    {probeOut.hint ? <div className="faint xs" style={{ marginTop: 6 }}>{probeOut.hint}</div> : null}
                  </div>
                ) : null}
              </form>

              {upKeys.length === 0 ? (
                <div className="adm-empty"><b>No upstream keys stored</b>Paste your first origin key above — users will never see it.</div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead>
                      <tr><th>Label</th><th>Upstream</th><th>Key</th><th>State</th><th className="num">Checked</th><th className="num">Ok / Fail</th><th className="num">Spend</th><th /></tr>
                    </thead>
                    <tbody>
                      {upKeys.map((k) => (
                        <React.Fragment key={k.id}>
                          <tr>
                            <td>
                              <b>{k.label}</b>
                              <div className="faint xs">{k.is_active ? "in rotation" : "paused"}{k.expires_at ? ` · expires ${relative(k.expires_at)}` : ""}</div>
                            </td>
                            <td className="faint">{k.upstream_name}</td>
                            <td className="mono">
                              {revealed[k.id] ? (
                                <span className="reveal-box" style={{ margin: 0, padding: "4px 8px" }}>
                                  <code>{revealed[k.id]}</code>
                                  <Button size="sm" variant="ghost" onClick={() => copy(revealed[k.id])}>Copy</Button>
                                </span>
                              ) : (
                                <>{k.masked_key} <span className="faint xs">({k.key_length} chars)</span></>
                              )}
                            </td>
                            <td>
                              <St value={k.status} />
                              {k.last_error && k.status !== "working" ? <div className="faint xs">{String(k.last_error).slice(0, 60)}</div> : null}
                            </td>
                            <td className="num faint xs">{k.last_checked_at ? relative(k.last_checked_at) : "never"}{k.last_latency_ms ? <div>{ms(k.last_latency_ms)}</div> : null}</td>
                            <td className="num">{num(k.success_count || 0)} / {num(k.failure_count || 0)}{k.consecutive_failures ? <div className="faint xs">{k.consecutive_failures} in a row</div> : null}</td>
                            <td className="num">{money(k.spend_usd || 0)}</td>
                            <td>
                              <div className="acts">
                                <Button size="sm" variant="ghost" loading={busy === `test:${k.id}`} onClick={() => runTest({ key_id: k.id }, k.id)}>Test</Button>
                                <select
                                  className="adm-select"
                                  style={{ width: 132 }}
                                  value={k.status}
                                  onChange={(e) => forceStatus(k.id, e.target.value)}
                                  aria-label="Set key state"
                                >
                                  {KEY_STATES.map((s) => (<option key={s} value={s}>{s.replace(/_/g, " ")}</option>))}
                                </select>
                                <Button size="sm" variant="ghost" onClick={() => toggleKeyActive(k)}>{k.is_active ? "Pause" : "Resume"}</Button>
                                <Button size="sm" variant="ghost" onClick={() => reveal(k.id)}>{revealed[k.id] ? "Hide" : "Reveal"}</Button>
                                <Button size="sm" variant="ghost" onClick={() => history(k.id)}>{checks[k.id] ? "Close" : "History"}</Button>
                                <Button size="sm" variant="danger" onClick={() => removeKey(k.id)}>Delete</Button>
                              </div>
                            </td>
                          </tr>
                          {checks[k.id] ? (
                            <tr>
                              <td colSpan={8} style={{ background: "var(--hover)" }}>
                                {checks[k.id].length === 0 ? (
                                  <span className="faint xs">No checks recorded yet.</span>
                                ) : (
                                  <ul className="stack small">
                                    {checks[k.id].map((c) => (
                                      <li key={c.id} className="row-between">
                                        <span className="mono xs">{dateTime(c.created_at)} · {c.source}</span>
                                        <span className="mono xs">{c.ok ? "ok" : "fail"} · {c.status_code ?? "—"} · {c.latency_ms ? ms(c.latency_ms) : "—"} {c.error ? `· ${String(c.error).slice(0, 48)}` : ""}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ==================================================== MODELS === */}
          {tab === "models" ? (
            <>
              <div className="adm-head">
                <div>
                  <h1>Model mapping</h1>
                  <p>
                    Public id is what your users call. Upstream model id is what we
                    send on. Users never see the right-hand side.
                  </p>
                </div>
              </div>

              <div className="adm-card">
                <h3><BoltIcon width={15} height={15} /> Scan models from an upstream</h3>
                <p className="sub">
                  Reads the provider's own model list and turns it into mappings —
                  ids, context windows and per-million prices wherever the provider
                  publishes them.
                </p>
                <div className="adm-grid">
                  <div>
                    <L req>Upstream</L>
                    <select className="adm-select" value={scan.upstream_id} onChange={(e) => setScan({ ...scan, upstream_id: e.target.value })}>
                      <option value="">Select an upstream…</option>
                      {upstreams.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                    </select>
                  </div>
                  <div>
                    <L>Key to scan with</L>
                    <input
                      className="adm-input mono"
                      type="password"
                      autoComplete="off"
                      value={scan.api_key}
                      onChange={(e) => setScan({ ...scan, api_key: e.target.value })}
                      placeholder="leave blank to use a stored key"
                    />
                  </div>
                </div>
                <div className="adm-form-actions">
                  <Button type="button" variant="primary" size="sm" loading={busy === "scan"} disabled={!scan.upstream_id} onClick={runScan}>Scan models</Button>
                  {!upstreams.length ? <span className="faint xs">Add an upstream first.</span> : null}
                  {scanOut && !scanOut.ok ? <span className="faint xs">HTTP {scanOut.status_code || "—"} from {scanOut.endpoint}</span> : null}
                </div>

                {scanOut?.ok ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="adm-grid">
                      <div>
                        <L>Public id prefix</L>
                        <input className="adm-input mono" value={scan.prefix} onChange={(e) => setScan({ ...scan, prefix: e.target.value })} placeholder="rr" />
                      </div>
                      <div>
                        <L>Price multiplier</L>
                        <input className="adm-input" type="number" step="0.01" value={scan.markup} onChange={(e) => setScan({ ...scan, markup: e.target.value })} />
                      </div>
                      <div>
                        <L>Fallback price in / 1M</L>
                        <input className="adm-input" type="number" step="0.0001" value={scan.fallbackIn} onChange={(e) => setScan({ ...scan, fallbackIn: e.target.value })} placeholder="0" />
                      </div>
                      <div>
                        <L>Fallback price out / 1M</L>
                        <input className="adm-input" type="number" step="0.0001" value={scan.fallbackOut} onChange={(e) => setScan({ ...scan, fallbackOut: e.target.value })} placeholder="0" />
                      </div>
                      <div>
                        <L>Import as</L>
                        <select className="adm-select" value={scan.status} onChange={(e) => setScan({ ...scan, status: e.target.value })}>
                          <option value="active">active</option>
                          <option value="preview">preview</option>
                          <option value="disabled">disabled</option>
                        </select>
                      </div>
                      <div>
                        <L>Filter</L>
                        <input className="adm-input" value={scanFilter} onChange={(e) => setScanFilter(e.target.value)} placeholder="gpt, claude, free…" />
                      </div>
                    </div>

                    <div className="adm-form-actions">
                      <Button type="button" variant="primary" size="sm" loading={busy === "import"} disabled={!selectedScanCount} onClick={importSelected}>
                        Import {selectedScanCount} selected
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setScanSel(Object.fromEntries(visibleScan.map((m) => [m.id, true])))}>Select all shown</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setScanSel({})}>Clear</Button>
                      <label className="faint xs" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={scan.overwrite} onChange={(e) => setScan({ ...scan, overwrite: e.target.checked })} />
                        overwrite mappings that already exist
                      </label>
                      <span className="faint xs">{scanOut.count} found on {scanOut.upstream} · {scanOut.endpoint}</span>
                    </div>

                    <div className="adm-table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
                      <table className="adm-table">
                        <thead>
                          <tr><th /><th>Upstream model id</th><th>Public id</th><th className="num">Context</th><th className="num">In / 1M</th><th className="num">Out / 1M</th></tr>
                        </thead>
                        <tbody>
                          {visibleScan.map((m) => (
                            <tr key={m.id}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={!!scanSel[m.id]}
                                  onChange={(e) => setScanSel({ ...scanSel, [m.id]: e.target.checked })}
                                  aria-label={`import ${m.id}`}
                                />
                              </td>
                              <td className="mono">{m.id}<div className="faint xs">{m.display_name}</div></td>
                              <td className="mono faint">{publicIdFor(m.id, scan.prefix)}</td>
                              <td className="num">{m.context_window ? compact(m.context_window) : "—"}</td>
                              <td className="num">{m.price_in_per_m != null ? `$${m.price_in_per_m}` : "—"}</td>
                              <td className="num">{m.price_out_per_m != null ? `$${m.price_out_per_m}` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {visibleScan.length === 0 ? <div className="adm-empty">Nothing matches that filter.</div> : null}
                  </div>
                ) : null}
              </div>

              <form className="adm-card" onSubmit={submitModel}>
                <h3>{modelForm.id ? "Edit mapping" : "Add a model mapping"}</h3>
                <div className="adm-grid">
                  <div>
                    <L req>Public model id</L>
                    <input className="adm-input mono" required value={modelForm.public_id} onChange={(e) => setModelForm({ ...modelForm, public_id: e.target.value })} placeholder="rs-core" />
                  </div>
                  <div>
                    <L>Display name</L>
                    <input className="adm-input" value={modelForm.display_name} onChange={(e) => setModelForm({ ...modelForm, display_name: e.target.value })} placeholder="RageStar Core" />
                  </div>
                  <div>
                    <L req>Upstream</L>
                    <select className="adm-select" required value={modelForm.upstream_id} onChange={(e) => setModelForm({ ...modelForm, upstream_id: e.target.value })}>
                      <option value="">Select…</option>
                      {upstreams.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
                    </select>
                  </div>
                  <div>
                    <L req>Upstream model id</L>
                    <input className="adm-input mono" required value={modelForm.upstream_model_id} onChange={(e) => setModelForm({ ...modelForm, upstream_model_id: e.target.value })} placeholder="provider/model-name" />
                  </div>
                  <div>
                    <L>Price in / 1M</L>
                    <input className="adm-input" type="number" step="0.0001" value={modelForm.price_in_per_m} onChange={(e) => setModelForm({ ...modelForm, price_in_per_m: e.target.value })} />
                  </div>
                  <div>
                    <L>Price out / 1M</L>
                    <input className="adm-input" type="number" step="0.0001" value={modelForm.price_out_per_m} onChange={(e) => setModelForm({ ...modelForm, price_out_per_m: e.target.value })} />
                  </div>
                  <div>
                    <L>Context window</L>
                    <input className="adm-input" type="number" value={modelForm.context_window} onChange={(e) => setModelForm({ ...modelForm, context_window: e.target.value })} />
                  </div>
                  <div>
                    <L>Max output tokens</L>
                    <input className="adm-input" type="number" value={modelForm.max_output_tokens} onChange={(e) => setModelForm({ ...modelForm, max_output_tokens: e.target.value })} />
                  </div>
                  <div>
                    <L>Capabilities (comma separated)</L>
                    <input className="adm-input" value={modelForm.capabilities} onChange={(e) => setModelForm({ ...modelForm, capabilities: e.target.value })} placeholder="chat, streaming, tools" />
                  </div>
                  <div>
                    <L>Status</L>
                    <select className="adm-select" value={modelForm.status} onChange={(e) => setModelForm({ ...modelForm, status: e.target.value })}>
                      <option value="active">active</option>
                      <option value="preview">preview</option>
                      <option value="deprecated">deprecated</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </div>
                  <div>
                    <L>Access</L>
                    <select className="adm-select" value={modelForm.access_tier || "public"} onChange={(e) => setModelForm({ ...modelForm, access_tier: e.target.value })}>
                      <option value="public">Everyone</option>
                      <option value="early_access">Early access only</option>
                    </select>
                  </div>
                  <div>
                    <L>Sort order</L>
                    <input className="adm-input" type="number" value={modelForm.sort_order} onChange={(e) => setModelForm({ ...modelForm, sort_order: e.target.value })} />
                  </div>
                </div>
                <div className="mt-4">
                  <L>Public description</L>
                  <input className="adm-input" value={modelForm.description} onChange={(e) => setModelForm({ ...modelForm, description: e.target.value })} placeholder="What users see on the models page" />
                </div>
                {modelForm.access_tier === "early_access" ? (
                  <div className="mt-4">
                    <L>Early access note</L>
                    <input className="adm-input" value={modelForm.access_note || ""} onChange={(e) => setModelForm({ ...modelForm, access_note: e.target.value })} placeholder="Shown beside the locked model, e.g. Beta group only" />
                    <p className="faint xs mt-2">
                      Only accounts with the <b>early access</b> role — and admins — can see or
                      call this model, in the dashboard and at the gateway. Needs
                      <span className="mono"> supabase/{EARLY_ACCESS_UPGRADE_FILE}</span>.
                    </p>
                  </div>
                ) : null}
                <div className="adm-form-actions">
                  <Button type="submit" variant="primary" size="sm" loading={busy === "model"} disabled={!upstreams.length}>
                    {modelForm.id ? "Save mapping" : "Add mapping"}
                  </Button>
                  {modelForm.id ? <Button type="button" size="sm" variant="ghost" onClick={() => setModelForm(EMPTY_MODEL)}>Cancel</Button> : null}
                </div>
              </form>

              {models.length === 0 ? (
                <div className="adm-empty"><b>No models published</b>Nothing appears on the public models page until you add a mapping.</div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>Public id</th><th>Routes to</th><th>Upstream</th><th className="num">In / Out per 1M</th><th>Access</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {models.map((m) => (
                        <tr key={m.id}>
                          <td><b className="mono">{m.public_id}</b><div className="faint xs">{m.display_name}</div></td>
                          <td className="mono">{m.upstream_model_id}</td>
                          <td className="faint">
                          {/kie original/i.test(m.upstreams?.name || "") ? (
                            <span className="sheet-chip kie">KIE ORIGINAL</span>
                          ) : (
                            m.upstreams?.name || "\u2014"
                          )}
                        </td>
                          <td className="num">{money(m.price_in_per_m)} / {money(m.price_out_per_m)}</td>
                          <td>
                            <button
                              type="button"
                              className={`st st-${m.access_tier === "early_access" ? "preview" : "working"}`}
                              style={{ border: 0, cursor: "pointer" }}
                              title="Switch this model between everyone and early access only."
                              onClick={() => toggleModelAccess(m)}
                            >
                              {m.access_tier === "early_access" ? "early access" : "everyone"}
                            </button>
                            {m.access_tier === "early_access" && m.access_note ? (
                              <div className="faint xs">{m.access_note}</div>
                            ) : null}
                          </td>
                          <td><St value={m.is_active ? m.status : "disabled"} /></td>
                          <td>
                            <div className="acts">
                              <Button size="sm" variant="ghost" onClick={() => editModel(m)}>Edit</Button>
                              <Button size="sm" variant="danger" onClick={() => removeModel(m.id)}>Delete</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ===================================================== USERS === */}
          {tab === "files" ? <FilesTab /> : null}
          {tab === "routing" ? <RoutingTab /> : null}
          {tab === "compressor" ? <CompressorTab /> : null}
          {tab === "ip" ? <IpTab /> : null}
          {tab === "kie" ? <KieTab /> : null}
          {tab === "gate" ? <GateTab /> : null}
          {tab === "inbox" ? <InboxTab onSync={setThreads} /> : null}
          {tab === "announcements" ? <AnnouncementsTab /> : null}

          {tab === "users" ? (
            <>
              <div className="adm-head">
                <div><h1>Users</h1><p>Everyone who signed up. Use <b>Recover</b> for lockouts — passwords are stored as one-way hashes and cannot be displayed.</p></div>
                <div className="acts"><Button size="sm" variant="ghost" onClick={loadAll}>Refresh</Button></div>
              </div>

              {recover ? (
                <div className="adm-card">
                  <h3><ShieldIcon width={15} height={15} /> Recovery — {recover.user.email}</h3>
                  <p className="sub">
                    Supabase Auth saves a bcrypt hash, never the password itself, so there is
                    nothing to reveal — not here, not over the API, not in SQL. Any of the three
                    below gets the account back, and each is recorded against your name.
                  </p>

                  {recover.err ? (
                    <div className="mb-4"><Alert tone="error" title="Did not work">{recover.err}</Alert></div>
                  ) : null}

                  <div className="adm-stats">
                    <div className="adm-stat">
                      <div className="l">Password</div>
                      <div className="v">{recover.security ? (recover.security.has_password ? "Set" : "None") : "…"}</div>
                      <div className="s">{recover.security?.password_changed_at ? `changed ${relative(recover.security.password_changed_at)}` : "never changed"}</div>
                    </div>
                    <div className="adm-stat">
                      <div className="l">Last sign-in</div>
                      <div className="v">{recover.security?.last_sign_in_at ? relative(recover.security.last_sign_in_at) : "never"}</div>
                      <div className="s">{(recover.security?.providers || []).join(", ") || "email"}</div>
                    </div>
                    <div className="adm-stat">
                      <div className="l">Live sessions</div>
                      <div className="v">{num(recover.security?.live_sessions || 0)}</div>
                      <div className="s">signed-in devices</div>
                    </div>
                    <div className="adm-stat">
                      <div className="l">Email</div>
                      <div className="v">{recover.security?.email_confirmed_at ? "Confirmed" : "Unconfirmed"}</div>
                      <div className="s">{recover.security?.email_confirmed_at ? relative(recover.security.email_confirmed_at) : "nothing on file"}</div>
                    </div>
                  </div>

                  {recover.link || recover.temp ? (
                    <>
                      <div className="reveal-box mt-4">
                        <code>{recover.link || recover.temp}</code>
                        <Button size="sm" variant="ghost" onClick={() => copy(recover.link || recover.temp)}>Copy</Button>
                      </div>
                      <p className="faint xs mt-2">
                        Shown once. Hand it over on a channel you trust, and ask them to change it.
                      </p>
                    </>
                  ) : null}

                  <div className="adm-form-actions">
                    <Button size="sm" variant="primary" loading={busy === "rec-link"} onClick={() => runRecover("link")}>Reset link</Button>
                    <Button size="sm" variant="ghost" loading={busy === "rec-temp"} onClick={() => runRecover("temp")}>Temporary password</Button>
                    <Button size="sm" variant="danger" loading={busy === "rec-out"} onClick={() => runRecover("out")}>Sign out everywhere</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRecover(null)}>Close</Button>
                  </div>
                </div>
              ) : null}
              {users.length === 0 ? (
                <div className="adm-empty"><b>No accounts yet</b>The first signup becomes an admin if the email is in the admin list.</div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>User</th><th>Role</th><th>State</th><th>IP limits</th><th>Referral</th><th className="num">Keys</th><th className="num">Req 30d</th><th className="num">Cost 30d</th><th>Last call</th><th /></tr></thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td><b>{u.full_name || "—"}</b><div className="faint xs">{u.email}</div></td>
                          <td>
                            <St value={u.role === "admin" ? "working" : u.role === "early_access" ? "preview" : "unknown"} />{" "}
                            <span className="faint xs">{roleLabel(u.role)}</span>
                          </td>
                          <td><St value={u.status} /></td>
                          <td>
                            <span className={`st st-${u.ip_limit_exempt ? "disabled" : "working"}`}>
                              {u.ip_limit_exempt
                                ? "exempt"
                                : Number(u.ip_rate_limit_rpm) > 0
                                  ? `${u.ip_rate_limit_rpm}/min`
                                  : "default"}
                            </span>
                          </td>
                          <td className="xs">
                            {u.referral_code ? <span className="mono">{u.referral_code}</span> : <span className="faint">—</span>}
                            {Number(u.invites_total) > 0 ? (
                              <div className="faint xs">{num(u.invites_total)} invited · {money(u.invites_earned_usd || 0)}</div>
                            ) : null}
                            {u.referred_by_email ? <div className="faint xs">via {u.referred_by_email}</div> : null}
                          </td>
                          <td className="num">{num(u.active_keys || 0)}</td>
                          <td className="num">{num(u.requests_30d || 0)}</td>
                          <td className="num">{money(u.cost_30d || 0)}</td>
                          <td className="faint xs">{u.last_request_at ? relative(u.last_request_at) : "never"}</td>
                          <td>
                            <div className="acts">
                              <select
                                className="adm-select"
                                style={{ height: 30, padding: "0 8px", width: "auto" }}
                                value={u.role || "user"}
                                title="User: public models. Early access: public + gated models. Admin: everything."
                                aria-label={`Role for ${u.email}`}
                                onChange={(e) => {
                                  const next = e.target.value;
                                  setUserRole(u.id, next)
                                    .then(() => listUsers().then(setUsers))
                                    .then(() => flash(`${u.email} is now ${roleLabel(next).toLowerCase()}.`))
                                    .catch((err) => setError(err.message));
                                }}
                              >
                                {ROLES.map((r) => (
                                  <option key={r.value} value={r.value}>{r.label}</option>
                                ))}
                              </select>
                              <Button size="sm" variant="ghost" title="Exempt this account from every IP limit, or put it back on the workspace defaults. Fine-tune in the IP limits tab." onClick={() => setUserIpRules(u.id, { exempt: !u.ip_limit_exempt }).then(() => listUsers().then(setUsers)).then(() => flash(u.ip_limit_exempt ? `${u.email} is subject to IP limits again.` : `${u.email} is no longer limited by IP.`)).catch((e) => setError(e.message))}>
                                {u.ip_limit_exempt ? "Limit IPs" : "Never limit IPs"}
                              </Button>
                              <Button size="sm" variant="ghost" title="Issue a reset link, set a temporary password, or end every session. The existing password cannot be displayed — only a hash of it is stored." onClick={() => openRecover(u)}>
                                Recover
                              </Button>
                              <Button size="sm" variant={u.status === "active" ? "danger" : "ghost"} onClick={() => setUserStatus(u.id, u.status === "active" ? "suspended" : "active").then(() => listUsers().then(setUsers)).catch((e) => setError(e.message))}>
                                {u.status === "active" ? "Suspend" : "Reinstate"}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ================================================= REFERRALS === */}
          {tab === "referrals" ? (
            <>
              <div className="adm-head">
                <div><h1>Referrals</h1><p>Who invited whom, and what it paid.</p></div>
                <div className="acts"><Button size="sm" variant="ghost" onClick={loadAll}>Refresh</Button></div>
              </div>

              {!refSettings ? (
                <Alert tone="warn" title="Referrals are not installed yet">
                  Open the Supabase SQL editor, paste <code>supabase/upgrade-v5.9-referrals.sql</code> from this project and press Run. Then reload this page.
                </Alert>
              ) : (
                <>
                  <div className="adm-stats">
                    <div className="adm-stat"><div className="l">Referrals</div><div className="v">{num(refRows.length)}</div><div className="s">all time</div></div>
                    <div className="adm-stat"><div className="l">Rewarded</div><div className="v">{num(refRows.filter((r) => r.status === "rewarded").length)}</div><div className="s">credit granted</div></div>
                    <div className="adm-stat"><div className="l">Pending</div><div className="v">{num(refRows.filter((r) => r.status === "pending").length)}</div><div className="s">awaiting review</div></div>
                    <div className="adm-stat">
                      <div className="l">Paid out</div>
                      <div className="v">{money(refRows.filter((r) => r.status === "rewarded").reduce((a, r) => a + Number(r.reward_usd || 0) + Number(r.bonus_usd || 0), 0))}</div>
                      <div className="s">inviter + invitee</div>
                    </div>
                  </div>

                  <form className="adm-card" onSubmit={submitReferralSettings}>
                    <h3><BoltIcon width={15} height={15} /> Programme</h3>
                    <p className="sub">Rewards move through the credit ledger, so every grant stays explainable.</p>
                    <div className="adm-grid">
                      <div><L>Status</L>
                        <select className="adm-select" value={refSettings.referrals_enabled ? "on" : "off"} onChange={(e) => setRefSettings((s) => ({ ...s, referrals_enabled: e.target.value === "on" }))}>
                          <option value="on">Enabled</option>
                          <option value="off">Disabled</option>
                        </select>
                      </div>
                      <div><L>Granted</L>
                        <select className="adm-select" value={refSettings.referral_reward_on || "signup"} onChange={(e) => setRefSettings((s) => ({ ...s, referral_reward_on: e.target.value }))}>
                          <option value="signup">On signup</option>
                          <option value="manual">After review</option>
                        </select>
                      </div>
                      <div><L>Inviter reward (USD)</L>
                        <input className="adm-input" type="number" min="0" step="0.01" value={refSettings.referral_reward_usd ?? 0} onChange={(e) => setRefSettings((s) => ({ ...s, referral_reward_usd: e.target.value }))} />
                      </div>
                      <div><L>Invitee bonus (USD)</L>
                        <input className="adm-input" type="number" min="0" step="0.01" value={refSettings.referral_bonus_usd ?? 0} onChange={(e) => setRefSettings((s) => ({ ...s, referral_bonus_usd: e.target.value }))} />
                      </div>
                      <div><L>Cap per inviter</L>
                        <input className="adm-input" type="number" min="0" step="1" value={refSettings.referral_max_per_user ?? 0} onChange={(e) => setRefSettings((s) => ({ ...s, referral_max_per_user: e.target.value }))} />
                        <p className="faint xs mt-2">0 = unlimited</p>
                      </div>
                    </div>
                    <div className="adm-form-actions">
                      <Button type="submit" variant="primary" loading={busy === "refset"}>Save</Button>
                    </div>
                  </form>

                  {refRows.length === 0 ? (
                    <div className="adm-empty"><b>No referrals yet</b>Every account gets a code automatically — users find their link under Referrals in the console.</div>
                  ) : (
                    <div className="adm-table-wrap">
                      <table className="adm-table">
                        <thead><tr><th>Inviter</th><th>Invitee</th><th>Code</th><th>Status</th><th className="num">Paid</th><th className="num">Calls</th><th>When</th><th /></tr></thead>
                        <tbody>
                          {refRows.map((r) => (
                            <tr key={r.id}>
                              <td className="xs">{r.referrer_email}</td>
                              <td className="xs">{r.invitee_email}</td>
                              <td className="mono xs">{r.code}</td>
                              <td>
                                <St value={r.status === "rewarded" ? "working" : r.status === "void" ? "disabled" : "unknown"} />
                                {r.note ? <div className="faint xs">{r.note}</div> : null}
                              </td>
                              <td className="num">{r.status === "rewarded" ? money(Number(r.reward_usd || 0) + Number(r.bonus_usd || 0)) : "—"}</td>
                              <td className="num">{num(r.invitee_requests || 0)}</td>
                              <td className="faint xs">{relative(r.created_at)}</td>
                              <td>
                                <div className="acts">
                                  {r.status === "pending" ? (
                                    <Button size="sm" variant="ghost" onClick={() => settleReferral(r.id).then(loadAll).then(() => flash("Referral credited.")).catch((e) => setError(e.message))}>
                                      Approve
                                    </Button>
                                  ) : null}
                                  {r.status !== "void" ? (
                                    <Button size="sm" variant="danger" onClick={() => {
                                      const note = window.prompt("Why void this referral?", "duplicate account");
                                      if (note === null) return;
                                      voidReferral(r.id, note).then(loadAll).then(() => flash("Referral voided.")).catch((e) => setError(e.message));
                                    }}>
                                      Void
                                    </Button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          ) : null}

          {/* =================================================== CREDITS === */}
          {tab === "credits" ? (
            <>
              <div className="adm-head">
                <div><h1>Credits</h1><p>Prepaid balances. Grants and per-request charges all land in the ledger, so the number is always explainable.</p></div>
                <div className="acts"><Button size="sm" variant="ghost" onClick={loadAll}>Refresh</Button></div>
              </div>

              {!hasCredits ? (
                <Alert tone="warn" title="Credits are not installed yet">
                  Open the Supabase SQL editor, paste <code>supabase/upgrade-v5.4.sql</code> from this project and press Run. Then reload this page.
                </Alert>
              ) : (
                <>
                  <div className="adm-stats">
                    <div className="adm-stat"><div className="l">Outstanding</div><div className="v">{money(creditTotals.balance)}</div><div className="s">held by {num(users.length)} accounts</div></div>
                    <div className="adm-stat"><div className="l">Granted</div><div className="v">{money(creditTotals.added)}</div><div className="s">lifetime</div></div>
                    <div className="adm-stat"><div className="l">Consumed</div><div className="v">{money(creditTotals.used)}</div><div className="s">lifetime, metered per request</div></div>
                    <div className="adm-stat"><div className="l">Enforcement</div><div className="v">{settings?.credits_enabled ? "On" : "Off"}</div><div className="s">{settings?.credits_enabled ? "gateway returns 402 at zero" : "tracked only — turn on in Settings"}</div></div>
                  </div>

                  <form className="adm-card" onSubmit={submitCredit}>
                    <h3><BoltIcon width={15} height={15} /> Move credit</h3>
                    <p className="sub">Add tops a balance up, deduct claws it back, set overwrites it outright. Every movement is attributed to you in the audit trail.</p>
                    <div className="adm-grid">
                      <div><L req>Account</L>
                        <select className="adm-select" value={creditForm.user_id} onChange={(e) => setCreditForm((f) => ({ ...f, user_id: e.target.value }))}>
                          <option value="">Choose an account…</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>{u.email} — {money(u.credit_balance_usd || 0)}</option>
                          ))}
                        </select>
                      </div>
                      <div><L>Action</L>
                        <select className="adm-select" value={creditForm.mode} onChange={(e) => setCreditForm((f) => ({ ...f, mode: e.target.value }))}>
                          <option value="add">Add credit</option>
                          <option value="deduct">Deduct credit</option>
                          <option value="set">Set exact balance</option>
                        </select>
                      </div>
                      <div><L req>Amount (USD)</L><input className="adm-input" type="number" step="0.01" placeholder="25.00" value={creditForm.amount} onChange={(e) => setCreditForm((f) => ({ ...f, amount: e.target.value }))} /></div>
                      <div><L>Note</L><input className="adm-input" placeholder="invoice 104 · goodwill · refund" value={creditForm.note} onChange={(e) => setCreditForm((f) => ({ ...f, note: e.target.value }))} /></div>
                    </div>
                    <div className="adm-form-actions">
                      <Button type="submit" variant="primary" size="sm" disabled={busy === "credit"}>
                        {busy === "credit" ? "Working…" : creditForm.mode === "set" ? "Set balance" : creditForm.mode === "deduct" ? "Deduct" : "Add credit"}
                      </Button>
                      {[5, 25, 100].map((amt) => (
                        <Button key={amt} type="button" size="sm" variant="ghost" onClick={() => setCreditForm((f) => ({ ...f, mode: "add", amount: String(amt) }))}>
                          ${amt}
                        </Button>
                      ))}
                    </div>
                  </form>

                  <div className="adm-card">
                    <h3>Balances</h3>
                    <p className="sub">What each account has left, and what it has burned through.</p>
                    {users.length === 0 ? (
                      <div className="adm-empty"><b>No accounts yet</b>Balances appear as soon as someone signs up.</div>
                    ) : (
                      <div className="adm-table-wrap">
                        <table className="adm-table">
                          <thead><tr><th>User</th><th className="num">Balance</th><th className="num">Added</th><th className="num">Used</th><th className="num">Cost 30d</th><th>Last call</th><th /></tr></thead>
                          <tbody>
                            {users.map((u) => {
                              const bal = Number(u.credit_balance_usd || 0);
                              return (
                                <tr key={u.id}>
                                  <td><b>{u.full_name || "—"}</b><div className="faint xs">{u.email}</div></td>
                                  <td className="num"><b className={bal <= 0 ? "credit-out" : undefined}>{money(bal)}</b></td>
                                  <td className="num">{money(u.credits_added_usd || 0)}</td>
                                  <td className="num">{money(u.credits_used_usd || 0)}</td>
                                  <td className="num">{money(u.cost_30d || 0)}</td>
                                  <td className="faint xs">{u.last_request_at ? relative(u.last_request_at) : "never"}</td>
                                  <td>
                                    <div className="acts">
                                      <Button size="sm" variant="ghost" onClick={() => setCreditForm({ user_id: u.id, mode: "add", amount: "", note: "" })}>Top up…</Button>
                                      <Button size="sm" variant="ghost" onClick={() => adjustUserCredits(u.id, 10, "quick top-up").then(() => refreshCredits(`Added $10.00 to ${u.email}.`)).catch((err) => setError(err.message))}>+$10</Button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  <div className="adm-card">
                    <h3>Ledger</h3>
                    <p className="sub">Newest first. Usage rows are written by the gateway as each request finishes.</p>
                    {ledger.length === 0 ? (
                      <div className="adm-empty"><b>Nothing yet</b>Grants and usage charges will show up here.</div>
                    ) : (
                      <div className="adm-table-wrap">
                        <table className="adm-table">
                          <thead><tr><th>When</th><th>Account</th><th>Type</th><th>Detail</th><th className="num">Amount</th><th className="num">Balance</th><th>By</th></tr></thead>
                          <tbody>
                            {ledger.map((row) => (
                              <tr key={row.id}>
                                <td className="faint xs">{dateTime(row.created_at)}</td>
                                <td>{row.user_email || "—"}</td>
                                <td><span className="faint xs">{String(row.kind || "").replace(/_/g, " ")}</span></td>
                                <td><span className="small">{row.description || "—"}</span>{row.request_id ? <div className="faint xs mono">{row.request_id}</div> : null}</td>
                                <td className="num"><span className={Number(row.delta_usd || 0) < 0 ? "credit-out" : "credit-in"}>{Number(row.delta_usd || 0) < 0 ? "−" : "+"}{money(Math.abs(Number(row.delta_usd || 0)))}</span></td>
                                <td className="num">{money(row.balance_after || 0)}</td>
                                <td className="faint xs">{row.actor_email || "system"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          ) : null}

          {/* ==================================================== ISSUED === */}
          {tab === "issued" ? (
            <>
              <div className="adm-head">
                <div><h1>Issued gateway keys</h1><p>Customer-facing rr_ keys. Only hashes are stored, so nothing here can be read back.</p></div>
              </div>
              {issued.length === 0 ? (
                <div className="adm-empty"><b>No gateway keys issued</b>Users mint their own from the console.</div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>Name</th><th>Key</th><th>Env</th><th>State</th><th className="num">Requests</th><th className="num">Spend</th><th>Last used</th></tr></thead>
                    <tbody>
                      {issued.map((k) => (
                        <tr key={k.id}>
                          <td>{k.name}</td>
                          <td className="mono">{k.key_prefix}••••••••{k.key_last4}</td>
                          <td className="faint xs">{k.environment}</td>
                          <td><St value={k.status} /></td>
                          <td className="num">{num(k.request_count || 0)}</td>
                          <td className="num">{money(k.spend_usd || 0)}</td>
                          <td className="faint xs">{k.last_used_at ? relative(k.last_used_at) : "never"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ====================================================== LOGS === */}
          {tab === "logs" ? (
            <>
              <div className="adm-head">
                <div><h1>Request logs</h1><p>Every routed call. Upstream identity is deliberately absent from this table.</p></div>
                <div className="adm-head-actions"><Button size="sm" variant="ghost" onClick={() => listAllLogs(100).then(setLogs)}>Refresh</Button></div>
              </div>
              <FilterBar
                showing={shownLogs.length}
                total={logs.length}
                dirty={logFilterDirty}
                onReset={resetLogFilter}
              >
                <SearchField
                  value={logFilter.q}
                  onChange={(v) => setLogFilter("q", v)}
                  placeholder="model, request id, error code, user…"
                />
                <Chips
                  options={[
                    { id: "ok", label: "Served" },
                    { id: "errors", label: "Failed" },
                  ]}
                  value={logFilter.state}
                  onChange={(v) => setLogFilter("state", v)}
                />
                <Chips
                  options={WINDOWS}
                  allowAll={false}
                  value={logFilter.window}
                  onChange={(v) => setLogFilter("window", v)}
                />
              </FilterBar>
              {shownLogs.length === 0 ? (
                <div className="adm-empty">
                  <b>{logs.length ? "Nothing matches those filters" : "No traffic yet"}</b>
                  {logs.length
                    ? "Widen the window or clear the search."
                    : "Send a request from the console playground to see it here."}
                </div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>When</th><th>User</th><th>Request id</th><th>Model</th><th className="num">HTTP</th><th className="num">Latency</th><th className="num">Tokens</th><th className="num">Cost</th><th className="num">Failover</th><th>Error</th></tr></thead>
                    <tbody>
                      {shownLogs.map((l) => (
                        <tr key={l.id}>
                          <td className="faint xs">{relative(l.created_at)}</td>
                          <td>
                            <div>{l.user_email || (l.user_id ? String(l.user_id).slice(0, 8) : "—")}</div>
                            {l.user_name ? <div className="faint xs">{l.user_name}</div> : null}
                          </td>
                          <td className="mono xs">{l.request_id}</td>
                          <td className="mono">{l.model_public_id}</td>
                          <td className="num"><span className={`st st-${l.ok ? "working" : "failing"}`}>{l.status_code}</span></td>
                          <td className="num">{ms(l.latency_ms)}</td>
                          <td className="num">{num((l.tokens_in || 0) + (l.tokens_out || 0))}</td>
                          <td className="num">{money(l.cost_usd || 0)}</td>
                          <td className="num">{l.failover_count || 0}</td>
                          <td className="faint xs">{l.error_code || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ===================================================== AUDIT === */}
          {tab === "audit" ? (
            <>
              <div className="adm-head">
                <div><h1>Audit trail</h1><p>Key reveals, status overrides, role changes and setting edits.</p></div>
              </div>
              <FilterBar
                showing={shownAudit.length}
                total={audit.length}
                dirty={auditFilterDirty}
                onReset={resetAuditFilter}
              >
                <SearchField
                  value={auditFilter.q}
                  onChange={(v) => setAuditFilter("q", v)}
                  placeholder="actor, action, entity…"
                />
                <Chips
                  options={WINDOWS}
                  allowAll={false}
                  value={auditFilter.window}
                  onChange={(v) => setAuditFilter("window", v)}
                />
              </FilterBar>
              {shownAudit.length === 0 ? (
                <div className="adm-empty">
                  <b>{audit.length ? "Nothing matches those filters" : "Nothing audited yet"}</b>
                  {audit.length
                    ? "Widen the window or clear the search."
                    : "Admin actions are appended here automatically."}
                </div>
              ) : (
                <div className="adm-table-wrap">
                  <table className="adm-table">
                    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
                    <tbody>
                      {shownAudit.map((a) => (
                        <tr key={a.id}>
                          <td className="faint xs">{dateTime(a.created_at)}</td>
                          <td>{a.actor_email || "system"}</td>
                          <td className="mono xs">{a.action}</td>
                          <td className="faint xs">{a.entity}{a.entity_id ? ` · ${String(a.entity_id).slice(0, 8)}` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}

          {/* ================================================== SETTINGS === */}
          {tab === "settings" && settings ? (
            <>
              <div className="adm-head">
                <div><h1>Settings</h1><p>Gateway-wide behaviour, stored in the single app_settings row.</p></div>
              </div>
              <form
                className="adm-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const patch = {
                    brand_name: f.get("brand_name"),
                    gateway_url: f.get("gateway_url"),
                    default_policy: f.get("default_policy"),
                    signup_enabled: f.get("signup_enabled") === "yes",
                    failover_enabled: f.get("failover_enabled") === "yes",
                    max_failover_hops: Number(f.get("max_failover_hops")),
                    log_retention_days: Number(f.get("log_retention_days")),
                  };
                  if (hasCredits) {
                    patch.credits_enabled = f.get("credits_enabled") === "yes";
                    patch.signup_credit_usd = Number(f.get("signup_credit_usd"));
                    patch.low_balance_usd = Number(f.get("low_balance_usd"));
                    patch.overdraft_usd = Number(f.get("overdraft_usd"));
                  }
                  if (hasWindows) {
                    patch.five_hour_limit_usd = Number(f.get("five_hour_limit_usd"));
                    patch.weekly_limit_usd = Number(f.get("weekly_limit_usd"));
                  }
                  if (hasDiscord) {
                    patch.discord_join_credit_usd = Number(f.get("discord_join_credit_usd"));
                  }
                  if (hasDiscordGate) {
                    patch.discord_required = f.get("discord_required") === "yes";
                  }
                  saveSet(patch);
                }}
              >
                <h3><BoltIcon width={15} height={15} /> Gateway behaviour</h3>
                <div className="adm-grid">
                  <div><L>Brand name</L><input className="adm-input" name="brand_name" defaultValue={settings.brand_name || ""} /></div>
                  <div><L>Public gateway URL</L><input className="adm-input" name="gateway_url" defaultValue={settings.gateway_url || ""} /></div>
                  <div><L>Default policy</L>
                    <select className="adm-select" name="default_policy" defaultValue={settings.default_policy || "auto:balanced"}>
                      <option value="auto:balanced">auto:balanced</option>
                      <option value="auto:cheapest">auto:cheapest</option>
                      <option value="auto:fastest">auto:fastest</option>
                    </select>
                  </div>
                  <div><L>Signups open</L>
                    <select className="adm-select" name="signup_enabled" defaultValue={settings.signup_enabled ? "yes" : "no"}>
                      <option value="yes">Yes</option>
                      <option value="no">No — invite only</option>
                    </select>
                  </div>
                  <div><L>Failover</L>
                    <select className="adm-select" name="failover_enabled" defaultValue={settings.failover_enabled ? "yes" : "no"}>
                      <option value="yes">Enabled</option>
                      <option value="no">Disabled</option>
                    </select>
                  </div>
                  <div><L>Max failover hops</L><input className="adm-input" type="number" name="max_failover_hops" defaultValue={settings.max_failover_hops ?? 3} /></div>
                  <div><L>Log retention (days)</L><input className="adm-input" type="number" name="log_retention_days" defaultValue={settings.log_retention_days ?? 30} /></div>
                </div>

                {hasCredits ? (
                  <>
                    <h3 className="mt-5"><KeyIcon width={15} height={15} /> Credits</h3>
                    <p className="sub">Enforcement ships off so nothing breaks the moment you upgrade. Turn it on once balances look right.</p>
                    <div className="adm-grid">
                      <div><L>Enforce credits</L>
                        <select className="adm-select" name="credits_enabled" defaultValue={settings.credits_enabled ? "yes" : "no"}>
                          <option value="yes">Yes — refuse requests at zero</option>
                          <option value="no">No — track balances only</option>
                        </select>
                      </div>
                      <div><L>Welcome credit (USD)</L><input className="adm-input" type="number" step="0.01" name="signup_credit_usd" defaultValue={settings.signup_credit_usd ?? 5} /></div>
                      <div><L>Low balance warning (USD)</L><input className="adm-input" type="number" step="0.01" name="low_balance_usd" defaultValue={settings.low_balance_usd ?? 1} /></div>
                      <div><L>Allowed overdraft (USD)</L><input className="adm-input" type="number" step="0.01" name="overdraft_usd" defaultValue={settings.overdraft_usd ?? 0} /></div>
                    </div>
                  </>
                ) : null}

                {hasWindows ? (
                  <>
                    <h3 className="mt-5"><BoltIcon width={15} height={15} /> Spend windows</h3>
                    <p className="sub">
                      Rolling caps per account, checked before every request. 0 means unlimited — leave both at 0 to keep the gateway uncapped.
                    </p>
                    <div className="adm-grid">
                      <div><L>5-hour limit (USD)</L><input className="adm-input" type="number" step="0.01" min="0" name="five_hour_limit_usd" defaultValue={settings.five_hour_limit_usd ?? 0} /></div>
                      <div><L>Weekly limit (USD)</L><input className="adm-input" type="number" step="0.01" min="0" name="weekly_limit_usd" defaultValue={settings.weekly_limit_usd ?? 0} /></div>
                    </div>
                  </>
                ) : null}

                {hasDiscord ? (
                  <>
                    <h3 className="mt-5"><SparkIcon width={15} height={15} /> Discord</h3>
                    <p className="sub">
                      Paid once per account when a signed-in user's Discord actually joins the community server — a failed join never pays, and disconnecting does not reset it. 0 disables the offer.
                    </p>
                    <div className="adm-grid">
                      <div><L>Join credit (USD)</L><input className="adm-input" type="number" step="0.01" min="0" name="discord_join_credit_usd" defaultValue={settings.discord_join_credit_usd ?? 50} /></div>
                      {hasDiscordGate ? (
                        <div><L>Require Discord for API access</L>
                          <select className="adm-select" name="discord_required" defaultValue={settings.discord_required ? "yes" : "no"}>
                            <option value="no">No — keys work without Discord</option>
                            <option value="yes">Yes — linked Discord + server membership required</option>
                          </select>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
                <div className="adm-form-actions">
                  <Button type="submit" variant="primary" size="sm">Save settings</Button>
                </div>
              </form>
            </>
          ) : null}
    </div>
  );

  /* Bare: the RageStar admin shell already rendered the rail, search and pulse;
     hand back just the content column. */
  if (bare) return adminBody;

  return (
    <main id="main" className="wk-page is-admin ap">
      <div className="wk-shell" data-collapsed={collapsed ? "true" : "false"}>
        <aside className="wk-rail">
          <div className="wk-rail-top">
            <a className="wk-brand" href="#/" title="RageStar home">
              <Logo size={28} />
              <span className="wk-brand-name">
                Rage<span className="dim">Star</span>
              </span>
            </a>
            <span className="wk-brand-tag">admin</span>
            <button type="button" className="wk-rail-toggle" aria-label={collapsed ? "Expand the rail" : "Collapse the rail"} title={collapsed ? "Expand the rail" : "Collapse the rail"} onClick={() => setCollapsed((v) => !v)}>
              {collapsed ? "»" : "«"}
            </button>
          </div>

          <div className="wk-rail-scroll">
            {GROUPS.map((g) => {
              const items = TABS.filter((t) => t.group === g.id);
              if (!items.length) return null;
              return (
                <div className="wk-group" key={g.id}>
                  <span className="wk-group-label">{g.label}</span>
                  <div className="wk-nav" role="tablist" aria-orientation="vertical" aria-label={`${g.label} sections`}>
                    {items.map((t) => {
                      const Icon = TAB_ICONS[t.id] || SparkIcon;
                      const badge = t.id === "inbox" && unread > 0 ? unread : counts[t.id];
                      return (
                        <button key={t.id} type="button" role="tab" id={`wk-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="wk-canvas" tabIndex={tab === t.id ? 0 : -1} title={t.hint} className={`wk-nav-item ${tab === t.id ? "is-on" : ""}`} onClick={() => setTab(t.id)}>
                          <span className="wk-nav-ico" aria-hidden="true">
                            <Icon width={15} height={15} />
                          </span>
                          <span className="wk-nav-label">{t.label}</span>
                          {badge ? <em className="wk-nav-count">{badge}</em> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="wk-rail-foot">
            <div className="wk-user">
              <span className="wk-avatar" aria-hidden="true">{initials(profile?.full_name || email)}</span>
              <span className="wk-user-meta">
                <b>{profile?.full_name || email}</b>
                <small>service role stays server-side</small>
              </span>
            </div>
            <div className="wk-rail-actions">
              <a className="wk-mini" href="#/dashboard">Dashboard</a>
              <a className="wk-mini" href="#/console">Console</a>
              <button type="button" className="wk-mini" onClick={() => signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="wk-main">
          <header className="wk-top">
            <div className="wk-crumb">
              <ShieldIcon width={14} height={14} />
              <span>Admin</span>
              <span className="wk-crumb-sep">/</span>
              <span>{activeGroup.label}</span>
              <span className="wk-crumb-sep">/</span>
              <b>{activeTab.label}</b>
            </div>
            <div className="wk-top-actions">
              <div className="ad-jump">
                <AdminTopbar current={tab} onJump={setTab} onRefresh={loadAll} />
              </div>
              <button type="button" className="wk-icon-btn" title={theme === "dark" ? "Switch to light" : "Switch to dark"} aria-label="Toggle theme" onClick={toggleTheme}>
                {theme === "dark" ? "☀" : "☾"}
              </button>
            </div>
          </header>

          <div className="wk-pulse">
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">requests 24h</span>
              <span className="wk-pulse-v">{compact(dash?.requests_24h ?? 0)}</span>
            </span>
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">errors 24h</span>
              <span className="wk-pulse-v">{num(dash?.errors_24h ?? 0)}</span>
            </span>
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">spend 24h</span>
              <span className="wk-pulse-v">{money(dash?.cost_24h ?? 0)}</span>
            </span>
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">latency</span>
              <span className="wk-pulse-v">{ms(dash?.avg_latency_24h ?? 0)}</span>
            </span>
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">keys working</span>
              <span className="wk-pulse-v">
                {num(dash?.keys_working ?? 0)}/{num(dash?.keys_total ?? 0)}
              </span>
            </span>
            <span className="wk-pulse-item">
              <span className="wk-pulse-l">member messages</span>
              <span className={`wk-pulse-v${unread > 0 ? " is-live" : ""}`}>
                {unread > 0 ? `${num(unread)} unread` : `${num(threads.length)} threads`}
              </span>
            </span>
          </div>

          <div className="wk-canvas" id="wk-canvas" role="tabpanel" aria-labelledby={`wk-tab-${tab}`}>
            {adminBody}
          </div>
        </div>
      </div>
    </main>
  );
}
