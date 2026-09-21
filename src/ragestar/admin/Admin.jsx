/* ==========================================================================
   Admin.jsx — the staff admin console, RageStar design, every real feature.
   --------------------------------------------------------------------------
   The kit's original demo panel (fake orgs, fake incidents, a region fleet
   that does not exist) is gone. This shell renders the gateway's REAL admin
   panel — src/pages/Admin.jsx in `bare` mode — inside the RageStar grouped
   rail: all 19 sections (dashboard, upstream keys, upstream APIs, routing,
   compressors, model mapping, KIE ORIGINAL, messages, users, issued keys,
   referrals, credits, IP limits, audit, request logs, gate denials, files,
   announcements, settings), live counts, the pulse strip, and the section
   search. The panel's own ap-, adm- and sui- surfaces are skinned to the paper
   theme by styles/admin-ragestar.css.
   ========================================================================== */

import { useEffect, useState } from "react";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { cn } from "../lib/cn.js";
import GatewayAdmin from "../../pages/Admin.jsx";

function Restricted({ onBack }) {
  return (
    <div className="relative z-10 grid min-h-screen place-items-center px-4">
      <div className="pr-glass-strong w-full max-w-lg rounded-3xl p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-brand-coral/30 bg-brand-coral/10">
          <svg viewBox="0 0 24 24" className="h-7 w-7 text-brand-coral" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Z" strokeLinejoin="round" />
            <path d="M9.5 12a2.5 2.5 0 1 1 5 0v1.2h1v4.3h-7v-4.3h1V12Z" strokeLinejoin="round" />
          </svg>
        </span>
        <h1 className="font-display mt-6 text-2xl font-semibold tracking-tight text-white">Staff workspace</h1>
        <p className="mx-auto mt-3 max-w-sm text-[13.5px] leading-relaxed text-white/55">
          The admin console is limited to staff accounts. Your current workspace
          doesn't carry the <span className="font-mono text-[12px] text-brand-coral">admin</span> role.
        </p>
        <div className="mt-7 flex flex-col gap-2.5">
          <button onClick={onBack} className="rounded-full border border-white/12 bg-white/5 px-5 py-3 text-[13px] text-white/70 hover:text-white">
            ← Back to console
          </button>
        </div>
        <p className="mt-5 font-mono text-[10.5px] tracking-[0.14em] text-white/30 uppercase">
          roles are assigned in the gateway admin panel
        </p>
      </div>
    </div>
  );
}

const GROUP_ICONS = {
  operations: "M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4Zm10-11h6V4h-6v5Z",
  routing: "M5 7h9l-3-3m3 3-3 3M19 17h-9l3-3m-3 3 3 3",
  customers: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-1a7 7 0 0 1 14 0v1",
  money: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  security: "M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Z",
  records: "M4 19V9m5 10V5m5 14v-7m5 7V8",
  config: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a8 8 0 0 1-.1 1.2l2 1.5-2 3.4-2.3-1a8 8 0 0 1-1.8 1.2L15.5 21h-7l-.3-2.7a8 8 0 0 1-1.8-1.2l-2.3 1-2-3.4 2-1.5A8 8 0 0 1 4 12a8 8 0 0 1 .1-1.2l-2-1.5 2-3.4 2.3 1a8 8 0 0 1 1.8-1.2L8.5 3h7l.3 2.7a8 8 0 0 1 1.8 1.2l2.3-1 2 3.4-2 1.5c.07.4.1.8.1 1.2Z",
};

function Icon({ path, className }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-4 w-4", className)} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Pulse({ label, value, live }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{label}</span>
      <span className={cn("font-mono text-[12px] tabular-nums", live ? "text-lime-300" : "text-white/80")}>{value}</span>
    </span>
  );
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function money(v) {
  return `$${num(v).toFixed(2)}`;
}
function compactN(v) {
  const n = num(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export default function AdminPanel({ session, view, navigate, onExit, isStaff }) {
  /* The real panel hands its grouped nav + pulse numbers up through this. */
  const [nav, setNav] = useState(null);
  const [clock, setClock] = useState(() => new Date());
  const [query, setQuery] = useState("");

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!isStaff) return <Restricted onBack={onExit} />;

  const groups = nav?.groups ?? [];
  const tabs = nav?.tabs ?? [];
  const activeGroup = nav?.activeGroup;
  const activeTab = nav?.activeTab;
  const dash = nav?.dash;
  const unread = nav?.unread ?? 0;

  const hits = query.trim()
    ? tabs
        .filter((t) => `${t.label} ${t.hint} ${t.keywords} ${t.group}`.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 6)
    : [];

  return (
    <div className="ragestar-admin relative min-h-screen text-[#101814]">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-40 h-[3px] bg-gradient-to-r from-brand-coral via-brand-ember to-brand-gold" />

      <header className="pr-glass-strong sticky top-0 z-30 mt-[3px] border-b border-white/8">
        <div className="mx-auto flex max-w-none flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="relative grid h-9 w-9 place-items-center">
              <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand-coral to-brand-ember opacity-90" />
              <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Z" strokeLinejoin="round" />
                <path d="M9 12l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="leading-tight">
              <p className="font-display text-[14px] font-semibold tracking-tight text-white">
                RageStar <span className="text-brand-coral">Staff</span>
              </p>
              <p className="font-mono text-[9px] tracking-[0.22em] text-white/40 uppercase">internal · do not share</p>
            </div>
            <DotmSquare1 size={18} dotSize={3} color="#E23D28" speed={0.9} className="hidden sm:inline-grid" aria-hidden />
          </div>

          {/* section jump — searches the real panel's own tab list */}
          <div className="relative order-3 w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-sm">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hits.length) {
                  nav?.onJump?.(hits[0].id);
                  setQuery("");
                }
                if (e.key === "Escape") setQuery("");
              }}
              placeholder='Jump to a section — try "failover", "credits", "keys"…'
              className="w-full rounded-full border border-white/10 bg-white/[0.05] py-2 pr-3 pl-9 text-[12.5px] text-white placeholder:text-white/35 focus:border-brand-coral/50 focus:outline-none"
            />
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-white/35" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.5-4.5" strokeLinecap="round" />
            </svg>
            {hits.length ? (
              <ul className="pr-glass-strong absolute top-full left-0 z-50 mt-2 w-full min-w-[280px] overflow-hidden rounded-2xl p-1.5 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.5)]">
                {hits.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => {
                        nav?.onJump?.(t.id);
                        setQuery("");
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
                    >
                      <span>
                        <span className="block text-[12.5px] text-white/90">{t.label}</span>
                        <span className="block font-mono text-[10px] text-white/40">{t.hint}</span>
                      </span>
                      <span className="font-mono text-[9px] tracking-[0.14em] text-white/30 uppercase">
                        {groups.find((g) => g.id === t.group)?.label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[11px] tabular-nums tracking-[0.1em] text-white/45 sm:inline">
              {clock.toUTCString().slice(17, 25)} UTC
            </span>
            <span className="hidden items-center gap-2.5 rounded-full border border-brand-coral/25 bg-brand-coral/10 px-3 py-1.5 font-mono text-[9.5px] tracking-[0.16em] text-rose-200 uppercase sm:flex">
              <DotmSquare1 size={13} dotSize={2} color="#E23D28" speed={1.2} aria-hidden />
              {activeGroup?.label ?? "admin"} · {activeTab?.label ?? "overview"}
            </span>
            <button
              onClick={onExit}
              className="rounded-full border border-white/12 bg-white/5 px-4 py-2 font-mono text-[10px] tracking-[0.16em] text-white/65 uppercase transition-colors hover:text-white"
            >
              ← console
            </button>
          </div>
        </div>

        {/* pulse strip — real 24h numbers from the gateway's adminDashboard */}
        <div className="border-t border-white/6">
          <div className="mx-auto flex max-w-none flex-wrap items-center gap-x-7 gap-y-2 px-4 py-2.5 sm:px-6">
            <Pulse label="requests 24h" value={compactN(dash?.requests_24h ?? 0)} live />
            <Pulse label="errors 24h" value={compactN(dash?.errors_24h ?? 0)} />
            <Pulse label="spend 24h" value={money(dash?.cost_24h ?? 0)} />
            <Pulse label="latency" value={`${num(dash?.avg_latency_24h ?? 0)}ms`} />
            <Pulse label="keys working" value={`${num(dash?.keys_working ?? 0)}/${num(dash?.keys_total ?? 0)}`} live />
            <Pulse label="member messages" value={unread > 0 ? `${unread} unread` : `${nav?.counts?.inbox ?? 0} threads`} />
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto flex max-w-none items-start gap-6 px-4 py-6 sm:px-6">
        {/* rail */}
        <aside className="sticky top-[128px] hidden max-h-[calc(100vh-150px)] w-[248px] shrink-0 overflow-y-auto rounded-2xl border border-white/8 bg-white/[0.03] p-3 backdrop-blur-xl lg:block">
          <div className="mb-2 flex items-center justify-between px-2 pt-1">
            <span className="font-mono text-[9px] tracking-[0.24em] text-white/35 uppercase">sections</span>
            <span className="font-mono text-[9px] text-white/30">{tabs.length}</span>
          </div>
          {groups.map((g) => {
            const items = tabs.filter((t) => t.group === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id} className="mb-3">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Icon path={GROUP_ICONS[g.id]} className="h-3 w-3 text-white/35" />
                  <span className="font-mono text-[9px] tracking-[0.22em] text-white/35 uppercase">{g.label}</span>
                </div>
                <div className="space-y-0.5">
                  {items.map((t) => {
                    const badge = t.id === "inbox" && unread > 0 ? unread : nav?.counts?.[t.id];
                    const active = nav?.tab === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => nav?.onJump?.(t.id)}
                        title={t.hint}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12.5px] transition-colors",
                          active
                            ? "border border-brand-coral/30 bg-brand-coral/10 text-white"
                            : "border border-transparent text-white/55 hover:bg-white/[0.05] hover:text-white",
                        )}
                      >
                        <span className={cn("h-1 w-1 shrink-0 rounded-full", active ? "bg-brand-coral" : "bg-white/25")} />
                        <span className="min-w-0 flex-1 truncate">{t.label}</span>
                        {badge ? (
                          <em className="shrink-0 rounded-full bg-white/8 px-1.5 font-mono text-[9px] not-italic text-white/45">
                            {badge}
                          </em>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="mt-3 border-t border-white/8 pt-3">
            <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-2.5 py-2.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-coral to-brand-ember font-display text-[10px] font-semibold text-white">
                {session.name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11.5px] text-white/85">{session.name}</span>
                <span className="block font-mono text-[8.5px] tracking-[0.14em] text-white/35 uppercase">service role stays server-side</span>
              </span>
            </div>
            <button
              onClick={() => navigate("dashboard")}
              className="mt-2 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-[12px] text-white/50 transition-colors hover:bg-white/[0.05] hover:text-white"
            >
              ← Member dashboard
            </button>
          </div>
        </aside>

        {/* content */}
        <main className="min-w-0 flex-1">
          <div className="mb-4 flex gap-2 overflow-x-auto rounded-2xl border border-white/8 bg-white/[0.03] p-2 lg:hidden">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => nav?.onJump?.(t.id)}
                className={cn(
                  "shrink-0 rounded-full border px-3.5 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors",
                  nav?.tab === t.id
                    ? "border-brand-coral/30 bg-brand-coral/10 text-rose-100"
                    : "border-white/10 bg-white/[0.03] text-white/50",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* The whole real admin panel, skinned to the RageStar paper theme by
              styles/admin-ragestar.css. */}
          <GatewayAdmin bare setNav={setNav} />
        </main>
      </div>

      <footer className="relative z-10 border-t border-white/8">
        <div className="mx-auto flex max-w-none flex-wrap items-center justify-between gap-2 px-4 py-4 font-mono text-[9.5px] tracking-[0.18em] text-white/30 uppercase sm:px-6">
          <span>staff console · every action is audit-logged</span>
          <span>signed in · {session.email}</span>
        </div>
      </footer>
    </div>
  );
}
