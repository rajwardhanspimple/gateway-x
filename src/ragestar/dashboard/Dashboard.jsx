import { useEffect, useMemo, useRef, useState } from "react";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { AreaChart, Bar, Sparkline } from "./chart.jsx";
import { DiscordPanel } from "./DiscordPanel.jsx";
import CommunityPanel from "../../pages/workspace/CommunityPanel.jsx";
import SheetGrid from "../../components/ui/SheetGrid.jsx";
/* Only real constants live in data.js now. Every panel used to fall back to a
   built-in fixture (demo requests, demo keys, demo spend) which rendered
   instantly and was then replaced by the account's real numbers — the visible
   "fake data first, then it changes" flicker. There is no fallback any more:
   panels start empty and fill in when the workspace answers. */
import { allScopes, models, ranges } from "./data.js";
import { CodeTabs, CopyButton, ModelCatalog } from "./models.jsx";
import Playground from "./playground.jsx";
import { cn } from "../lib/cn.js";
import { useCatalog, useWorkspace } from "../lib/workspace.js";
import { API_HOST } from "../lib/gateway.js";

const navItems = [
  { id: "overview", label: "Overview", icon: "M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-4H4v4Zm10-11h6V4h-6v5Z" },
  { id: "models", label: "Models", icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12v9M12 12 4 7.5" },
  { id: "playground", label: "Playground", icon: "M4 5h16v10H4V5Zm5 14h6M12 15v4" },
  { id: "keys", label: "API keys", icon: "M14 7a4 4 0 1 0-3.5 5.9L9 14.4V17H6.5L4 19.5V21h3v-2h2v-2h1.6l1.5-1.5A4 4 0 0 0 14 7Z" },
  { id: "usage", label: "Usage & billing", icon: "M4 19V9m5 10V5m5 14v-7m5 7V8" },
  { id: "logs", label: "Usage logs", icon: "M5 4h14v16H5V4Zm3 4h8M8 12h8M8 16h5" },
  { id: "community", label: "Community", icon: "M4 5h16v11H9l-5 4V5Zm3.5 4h9M7.5 12h6" },
  { id: "settings", label: "Settings", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2-1.2L14.6 3H9.4L9 5.7a7.6 7.6 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2 1.2l.4 2.7h5.2l.4-2.7a7.6 7.6 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2Z" },
];

function Icon({ path, className }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-4 w-4", className)} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Panel({ title, subtitle, action, children, className, bodyClassName }) {
  return (
    <section className={cn("rounded-2xl border border-white/8 bg-white/[0.025] backdrop-blur-sm transition-colors hover:border-white/14", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
        <div>
          <h2 className="font-display text-[15px] font-semibold tracking-tight text-white">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12px] text-white/45">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

function Delta({ value, invert = false }) {
  /* Live KPIs have no previous period to compare against, so they pass null
     and get no chip at all â€” a "0.0%" badge would be a lie, not a neutral. */
  if (value == null || !Number.isFinite(value)) return null;
  const good = invert ? value <= 0 : value >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] tabular-nums",
        good ? "border-lime-400/25 bg-lime-500/10 text-lime-300" : "border-rose-400/25 bg-rose-500/10 text-rose-200",
      )}
    >
      <svg viewBox="0 0 24 24" className={cn("h-2.5 w-2.5", value < 0 && "rotate-180")} fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

function Switch({ on, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label={label}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-300",
        on ? "border-brand-ember/50 bg-gradient-to-r from-orange-500/70 to-rose-500/60" : "border-white/12 bg-white/8",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 rounded-full bg-white transition-all duration-300",
          on ? "left-[22px]" : "left-0.5",
        )}
        style={{ height: 18, width: 18 }}
      />
    </button>
  );
}

function KpiCard({ kpi, spark, color, invert }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025] p-5 transition-colors hover:border-white/16">
      <div className="flex items-start justify-between gap-3">
        <span className="font-mono text-[10px] tracking-[0.2em] text-white/45 uppercase">{kpi.label}</span>
        <Delta value={kpi.delta} invert={invert} />
      </div>
      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="font-display text-[2rem] leading-none font-semibold tracking-tight tabular-nums text-white">{kpi.value}</span>
        {kpi.unit && <span className="font-mono text-xs text-white/45">{kpi.unit}</span>}
      </div>
      <div className="mt-1.5 text-[11.5px] text-white/40">{kpi.note}</div>
      <Sparkline points={spark} color={color} className="mt-3 h-9 w-full" />
    </div>
  );
}

/** Streaming inference monitor â€” tokens/sec, queue depth, p50/p95, failovers. */
function RequestsTable({ query, ws }) {
  /* Live request logs, or an empty table until they arrive. Showing a sample
     tail while the real log loads is what made the panel look like it was
     lying for a moment. */
  const rows = useMemo(() => (ws?.requests ?? []).slice(0, 60), [ws?.requests]);
  const filtered = query
    ? rows.filter((r) => `${r.model} ${r.id} ${r.endpoint} ${r.region}`.toLowerCase().includes(query.toLowerCase()))
    : rows;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr className="border-b border-white/8">
            {["Request", "Model", "Tokens in / out", "Latency", "Endpoint", "Status"].map((h, i) => (
              <th
                key={h}
                className={cn(
                  "px-4 py-3 font-mono text-[10px] font-normal tracking-[0.16em] text-white/40 uppercase",
                  i > 1 ? "text-right" : "text-left",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id} className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03]">
              <td className="px-4 py-3">
                <span className="block font-mono text-[11.5px] text-white/80">{r.id}</span>
                <span className="block font-mono text-[10px] text-white/35">{r.time} Â· {r.region}</span>
              </td>
              <td className="px-4 py-3 text-[12.5px] text-white/75">{r.model}</td>
              <td className="px-4 py-3 text-right font-mono text-[11.5px] tabular-nums text-white/70">
                {r.tokensIn.toLocaleString()} <span className="text-white/25">/</span> {r.tokensOut.toLocaleString()}
              </td>
              <td className={cn("px-4 py-3 text-right font-mono text-[11.5px] tabular-nums", r.latency > 2000 ? "text-amber-200" : "text-white/70")}>
                {r.latency}ms
              </td>
              <td className="px-4 py-3 text-right font-mono text-[11px] text-white/50">{r.endpoint}</td>
              <td className="px-4 py-3 text-right">
                <span
                  className={cn(
                    "rounded-full border px-2.5 py-1 font-mono text-[10px]",
                    r.status === "200"
                      ? "border-lime-400/25 bg-lime-500/10 text-lime-300"
                      : r.status === "429"
                        ? "border-amber-400/25 bg-amber-500/10 text-amber-200"
                        : "border-rose-400/25 bg-rose-500/10 text-rose-200",
                  )}
                >
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-[13px] text-white/45">
                {ws?.loading ? "Loading requests..." : !ws?.logsLoaded ? "Usage logs are unavailable. Use Refresh to retry." : query ? `No requests match "${query}".` : "No requests in this range yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- expiry */
/* The create dialog's expiry presets. `days` is an offset from the moment the
   key is minted; a preset without one (Never, Pick a date) is handled by
   resolveExpiry() below. api_keys.expires_at is nullable, and the router only
   rejects a key when a date exists and has already gone by. */
const EXPIRY_PRESETS = [
  { id: "never", label: "Never" },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "custom", label: "Pick a date" },
];

const pad2 = (n) => String(n).padStart(2, "0");

/** Today + offset days as YYYY-MM-DD in the browser's own timezone — the
 *  format a native <input type="date"> reads and writes. */
function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The ISO instant to store for a preset, or null for a key that never
 *  expires. A custom date holds the key to the END of the chosen day, so
 *  "expires on the 30th" does not cut the key off one second after midnight. */
function resolveExpiry(mode, customDay) {
  const preset = EXPIRY_PRESETS.find((p) => p.id === mode);
  if (preset?.days) {
    const d = new Date();
    d.setDate(d.getDate() + preset.days);
    return d.toISOString();
  }
  if (mode !== "custom" || !customDay) return null;
  const d = new Date(`${customDay}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Client-side mirror of the server's own check. A date already in the past
 *  would mint a key the router rejects on its very first call, so it is
 *  refused here rather than becoming a mystery 401 later. */
function expiryProblem(mode, customDay) {
  if (mode !== "custom") return "";
  if (!customDay) return "Pick the date this key should stop working.";
  if (new Date(`${customDay}T23:59:59`).getTime() <= Date.now()) {
    return "That date has already passed — choose one in the future, or Never.";
  }
  return "";
}

/** What the reveal panel says the key's expiry is. */
function expiryLabel(mode, customDay) {
  const preset = EXPIRY_PRESETS.find((p) => p.id === mode);
  if (mode === "custom") return customDay || "never";
  return preset?.days ? preset.label : "never";
}

function KeysView({ ws, onUseInPlayground }) {
  /* Starts empty. The kit used to seed five demo keys here, so the list showed
     "Production server / Staging / Notebook" for a beat before the account's
     real keys replaced them. */
  const [keys, setKeys] = useState([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [env, setEnv] = useState("live");
  const [scopes, setScopes] = useState(["chat"]);
  const [budget, setBudget] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [customDay, setCustomDay] = useState("");
  const [revealed, setRevealed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  /* Back to a blank dialog, so the next key starts clean instead of inheriting
     the previous one's name, cap and expiry. */
  const resetForm = () => {
    setName("");
    setScopes(["chat"]);
    setBudget("");
    setExpiry("never");
    setCustomDay("");
  };

  /* Real keys replace the fixture list as soon as they arrive. The refresh
     after every write changes the array identity, so this keeps the panel in
     sync without the writes having to patch state by hand. */
  useEffect(() => {
    if (ws?.keys) setKeys(ws.keys);
  }, [ws?.keys]);

  /* The dialog declares aria-modal, which tells assistive tech that the page
     behind it is inert — so focus has to actually move into it, or a keyboard
     user is left tabbing around behind the scrim. Escape is the standard way
     out of a modal, alongside Cancel and the backdrop. */
  useEffect(() => {
    if (!creating) return undefined;
    nameRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") setCreating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);

  const create = async () => {
    const label = name.trim() || "Untitled key";
    setError(null);

    /* Check the expiry before anything else. It is the one field the user can
       get wrong in a way the server rejects anyway — better to say so here
       than to bounce the whole create off the RPC. */
    const expiryIssue = expiryProblem(expiry, customDay);
    if (expiryIssue) {
      setError(expiryIssue);
      return;
    }
    const expiresAt = resolveExpiry(expiry, customDay);
    const expiresLabel = expiryLabel(expiry, customDay);

    /* No gateway to mint against: keep the kit's optimistic demo behaviour,
       but never hand back something that looks like a spendable key. A bare
       `sk_live_…` is indistinguishable from a real one once it is pasted into
       a .env file, so demo secrets are stamped and the reveal says so. */
    if (!ws?.actions) {
      const secret = `sk_demo_${env}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
      setKeys((k) => [
        {
          id: `k${Date.now()}`,
          name: label,
          prefix: `${secret.slice(0, 12)}â€¦${secret.slice(-4)}`,
          scopes,
          created: "just now",
          lastUsed: "never",
          requests: 0,
          env,
          expiresAt,
          expires: expiresLabel,
          expired: false,
        },
        ...k,
      ]);
      setRevealed({ name: label, secret, demo: true, expires: expiresLabel });
      setCreating(false);
      resetForm();
      return;
    }

    setBusy(true);
    try {
      /* A request that never resolves (network stall, dropped edge call) would
         otherwise leave busy=true and this modal's blurred backdrop up forever
         — the "screen blurs and nothing happens" symptom. Race the write
         against a timeout so the dialog always returns to a readable state
         with an error the user can act on, instead of a frozen blur. */
      const row = await Promise.race([
        ws.actions.createKey({
          name: label,
          environment: env,
          budget: budget === "" ? null : Number(budget),
          expiresAt,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "The request timed out before the gateway answered. Check your connection and try again — no key was created.",
                ),
              ),
            30000,
          ),
        ),
      ]);
      const secret = row?.api_key || row?.secret || "";

      /* The RPC can succeed and still return nothing — a void function, a
         row without the column, a policy that hides it. Showing an empty box
         with a Copy button is worse than saying so: the user copies nothing,
         and finds out as a 401 in production. Keep the dialog up and explain,
         because the key probably *was* created. */
      if (!secret) {
        setError(
          "The gateway accepted the key but did not return a secret. It may already be in your list — rotate it there to get a usable one.",
        );
        return;
      }

      setRevealed({ name: label, secret, expires: expiresLabel });
      setCreating(false);
      resetForm();
    } catch (err) {
      /* Staying open is deliberate: the user can fix the name and retry. The
         reason has to be rendered *inside* this dialog — see the alert below,
         which is the only part of the screen still readable once the backdrop
         is up. */
      setError(err?.message || "Could not create the key");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key) => {
    setError(null);
    if (!ws?.actions) {
      setKeys((prev) => prev.filter((x) => x.id !== key.id));
      return;
    }
    setBusy(true);
    try {
      await ws.actions.revokeKey(key.id);
    } catch (err) {
      setError(err?.message || "Could not revoke the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { k: "active keys", v: `${keys.length}` },
          { k: "requests (30d)", v: `${(keys.reduce((a, k) => a + k.requests, 0) / 1_000_000).toFixed(2)}M` },
          { k: "keys expiring", v: "0" },
        ].map((s) => (
          <Panel key={s.k} title={s.k} bodyClassName="p-5">
            <div className="font-display text-[1.8rem] font-semibold tabular-nums text-white">{s.v}</div>
          </Panel>
        ))}
      </div>

      <Panel
        title="API keys"
        subtitle="keep live keys server-side Â· rotate every 90 days"
        action={
          <button
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-4 py-2 text-[12.5px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)]"
          >
            Create key
          </button>
        }
        bodyClassName="p-0"
      >
        <ul className="divide-y divide-white/6">
          {error ? (
            <li className="px-5 py-3 text-[12.5px] text-rose-200">{error}</li>
          ) : null}
          {keys.length === 0 ? (
            <li className="px-5 py-8 text-center text-[12.5px] text-white/45">
              No keys yet â€” create one to start calling the gateway.
            </li>
          ) : null}
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-[13.5px] font-medium text-white/90">{k.name}</span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 font-mono text-[9.5px] tracking-[0.14em] uppercase",
                      k.env === "live" ? "border-lime-400/25 bg-lime-500/10 text-lime-300" : "border-white/12 bg-white/5 text-white/50",
                    )}
                  >
                    {k.env}
                  </span>
                  {k.expired ? (
                    <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.14em] text-rose-200 uppercase">
                      expired
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 font-mono text-[11px] text-white/45">
                  {k.prefix} Â· created {k.created} Â· last used {k.lastUsed}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {k.scopes.map((s) => (
                    <span key={s} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[9.5px] tracking-[0.12em] text-white/55 uppercase">
                      {s}
                    </span>
                  ))}
                </div>
                <div className="mt-1.5 font-mono text-[10px] tracking-[0.12em] text-white/35 uppercase">
                  {k.expiresAt ? `expires ${k.expires}` : "no expiry"}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="font-mono text-[12.5px] tabular-nums text-white/80">{k.requests.toLocaleString()}</div>
                  <div className="font-mono text-[9.5px] tracking-[0.14em] text-white/35 uppercase">requests</div>
                </div>
                <button
                  onClick={() => revoke(k)}
                  disabled={busy}
                  className="rounded-full border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2 font-mono text-[10.5px] tracking-[0.14em] text-rose-200 uppercase transition-colors hover:bg-rose-500/20 disabled:opacity-60"
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Authentication quickstart" subtitle="OpenAI-compatible clients work unchanged">
        <CodeTabs modelId="ragestar-4-mini" />
      </Panel>

      {creating && (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          {/* The scrim is ink, not paper. In this kit `ink-950` is the light
              drafting-paper surface, so the old `bg-ink-950/75` backdrop
              washed the page white and the equally pale `bg-ink-900/95` panel
              disappeared into it — which is exactly what "the screen goes
              blur" looked like from the outside. */}
          <button
            aria-label="Close"
            onClick={() => setCreating(false)}
            className="absolute inset-0 bg-[#101814]/55 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ck-title"
            className="relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border-2 border-[#101814] bg-[#f1f3eb] p-6 shadow-[8px_8px_0_0_rgba(16,24,20,0.35)]"
          >
            <h2 id="ck-title" className="font-display text-lg font-semibold tracking-tight text-white">Create API key</h2>
            <p className="mt-1.5 text-[12.5px] text-white/50">
              Name it, decide when it should stop working, and scope it to the
              endpoints it needs. The secret is shown once.
            </p>

            {/* No gateway configured: say it before the user types, not after
                they have pasted a demo secret into a client. */}
            {!ws?.actions ? (
              <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-100">
                No gateway is connected, so this only mints a demo key in your browser. It will not
                authenticate a request and it disappears on reload.
              </p>
            ) : null}

            {/* The reason a create failed. It used to live in the keys list
                underneath — behind this backdrop, and therefore invisible —
                which is what made a failure look like a frozen blur screen. */}
            {error ? (
              <p
                role="alert"
                className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-[12.5px] text-rose-100"
              >
                {error}
              </p>
            ) : null}

            <label className="mt-5 block">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">key name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Production Â· worker-3"
                className="mt-2 w-full rounded-xl border border-white/15 bg-white/[0.05] px-3.5 py-2.5 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
              />
            </label>

            <div className="mt-5">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">environment</span>
              <div className="mt-2 flex gap-2">
                {["live", "test"].map((e) => (
                  <button
                    key={e}
                    onClick={() => setEnv(e)}
                    className={cn(
                      "rounded-full border px-3.5 py-1.5 font-mono text-[10.5px] tracking-[0.14em] uppercase transition-colors",
                      env === e ? "border-brand-ember/45 bg-brand-ember/12 text-orange-100" : "border-white/10 bg-white/[0.04] text-white/50",
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {/* Expiry — stored in api_keys.expires_at, and enforced by the
                router on every call ("API key has expired." → 401), so a key
                that leaks cannot be used forever. */}
            <div className="mt-5">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">expires</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {EXPIRY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setExpiry(p.id);
                      /* Give the date field a sensible starting point that
                         is already valid, instead of an empty picker. */
                      if (p.id === "custom" && !customDay) setCustomDay(isoDay(30));
                    }}
                    className={cn(
                      "rounded-full border px-3 py-1.5 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors",
                      expiry === p.id
                        ? "border-brand-ember/45 bg-brand-ember/12 text-orange-100"
                        : "border-white/15 bg-white/[0.04] text-white/50",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {expiry === "custom" ? (
                <input
                  type="date"
                  value={customDay}
                  min={isoDay(1)}
                  onChange={(e) => setCustomDay(e.target.value)}
                  aria-label="Expiry date"
                  className="mt-3 w-full rounded-xl border border-white/15 bg-white/[0.05] px-3.5 py-2.5 font-mono text-[12.5px] text-white focus:border-brand-ember/60 focus:outline-none"
                />
              ) : null}

              <p className="mt-2 text-[11px] text-white/45">
                {expiryProblem(expiry, customDay) ||
                  (expiry === "never"
                    ? "Keeps working until you revoke it."
                    : `Requests with this key stop working after ${expiryLabel(expiry, customDay)}.`)}
              </p>
            </div>

            <div className="mt-5">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">scopes</span>
              <div className="mt-2 flex flex-wrap gap-2">
                {allScopes.map((s) => {
                  const on = scopes.includes(s);
                  return (
                    <button
                      key={s}
                      onClick={() => setScopes((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))}
                      className={cn(
                        "rounded-full border px-3 py-1.5 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors",
                        on ? "border-lime-400/35 bg-lime-500/12 text-lime-200" : "border-white/10 bg-white/[0.04] text-white/50",
                      )}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* The cap the router checks before it spends anything on this
                key. Blank means uncapped. */}
            <label className="mt-5 block">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">
                monthly cap (usd) · optional
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="no cap"
                className="mt-2 w-full rounded-xl border border-white/15 bg-white/[0.05] px-3.5 py-2.5 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
              />
            </label>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setCreating(false)}
                className="rounded-full border border-white/12 bg-white/5 px-4 py-2.5 text-[12.5px] text-white/70 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={busy}
                className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-2.5 text-[12.5px] font-medium text-white disabled:opacity-60"
              >
                {busy ? "Creatingâ€¦" : "Create secret key"}
              </button>
            </div>
          </div>
        </div>
      )}

      {revealed && (
        <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <button
            aria-label="Close"
            onClick={() => setRevealed(null)}
            className="absolute inset-0 bg-[#101814]/55 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rk-title"
            className="relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border-2 border-[#0d7a66] bg-[#f1f3eb] p-6 shadow-[8px_8px_0_0_rgba(16,24,20,0.35)]"
          >
            <h2 id="rk-title" className="font-display text-lg font-semibold tracking-tight text-white">
              â€œ{revealed.name}â€ created
            </h2>
            <p className="mt-1.5 text-[12.5px] text-white/50">
              Copy it now â€” this is the only time the full secret is shown.
            </p>
            {revealed.demo ? (
              <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-100">
                Demo key â€” it exists only in this browser tab. It is not in your account and will not
                authenticate a request.
              </p>
            ) : null}
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-white/15 bg-white/[0.06] p-3.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-lime-300">{revealed.secret}</code>
              <CopyButton text={revealed.secret} label="Copy" />
            </div>
            <p className="mt-3 font-mono text-[11px] tracking-[0.1em] text-white/45 uppercase">
              expires · {revealed.expires || "never"}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                onClick={() => setRevealed(null)}
                className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3 text-[13px] font-medium text-white"
              >
                I have stored it safely
              </button>
              {/* The old console's handoff, restored: carry this key straight
                  into the playground so the first prompt is a real gateway
                  call — and the first row in the usage log. */}
              {!revealed.demo && onUseInPlayground ? (
                <button
                  onClick={() => onUseInPlayground(revealed.secret)}
                  className="rounded-full border border-white/12 bg-white/[0.05] px-5 py-3 text-[13px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Use in playground
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The same columns and spreadsheet interactions as the previous Usage tab.
const USAGE_COLUMNS = [
  { key: "created_at", label: "When", type: "datetime", width: 166 },
  { key: "model", label: "Model", width: 150, mono: true },
  { key: "provider", label: "Provider", width: 132 },
  { key: "dialect", label: "Dialect", width: 96 },
  { key: "harness", label: "Harness", width: 118 },
  { key: "policy", label: "Policy", width: 106 },
  { key: "ok", label: "Result", type: "bool", width: 86,
    render: (r) => <span className={`sheet-chip ${r.ok ? "ok" : "bad"}`}>{r.ok ? "ok" : "failed"}</span> },
  { key: "status_code", label: "Status", type: "int", width: 78, total: false },
  { key: "latency_ms", label: "Latency", type: "ms", width: 98, total: false },
  { key: "tokens_in", label: "Tokens in", type: "tokens", width: 96 },
  { key: "tokens_out", label: "Tokens out", type: "tokens", width: 104 },
  { key: "tokens_total", label: "Tokens", type: "tokens", width: 96 },
  { key: "cost_usd", label: "Cost", type: "money", width: 96 },
  { key: "streamed", label: "Streamed", type: "bool", width: 96 },
  { key: "request_id", label: "Request id", width: 188, mono: true },
  { key: "error_code", label: "Error", width: 140 },
];

function UsageLogs({ ws, query = "" }) {
  const rows = useMemo(() => {
    const data = ws?.usageRows ?? [];
    const q = query.trim().toLowerCase();
    return q ? data.filter((row) => USAGE_COLUMNS.some((col) => String(row[col.key] ?? "").toLowerCase().includes(q))) : data;
  }, [ws?.usageRows, query]);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-white/55">
        Newest first. Refreshes every 30 seconds while visible, and when you return to this tab.
        {ws?.logsUpdatedAt ? ` Last updated: ${new Date(ws.logsUpdatedAt).toLocaleTimeString()}.` : ""}
        {ws?.logsLimited ? " Showing the newest 2,000 requests; narrow the range for older detail. Model breakdowns cover these loaded rows; summary totals cover the full range." : ""}
      </p>
      <SheetGrid
        title="Usage logs"
        subtitle={`${rows.length.toLocaleString()} rows / last ${ws?.days ?? 30}d`}
        columns={USAGE_COLUMNS}
        rows={rows}
        loading={Boolean(ws?.loading)}
        filename={`usage-${ws?.days ?? 30}d.csv`}
        emptyLabel={ws?.logsLoaded ? "No requests in this range match your filters." : "Usage logs are unavailable. Use Refresh to retry."}
      />
    </div>
  );
}

function UsageView({ session, ws, query }) {
  const spent = ws?.summary ? Number(ws.summary.cost_usd) || 0 : null;
  const spentLabel = spent == null ? "—" : `$${spent.toFixed(2)}`;
  const period = `last ${ws?.days ?? 30} days`;
  const usageRows = ws?.usageByModel ?? [];
  const invoiceRows = ws?.invoices ?? [];
  const balance = ws?.credits?.credit_balance_usd ?? session.credits;
  return (
    <div className="space-y-4">
      <UsageLogs ws={ws} query={query} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Current period" subtitle={period} className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="font-display text-4xl font-semibold tabular-nums text-white">{spentLabel}</div>
              <p className="mt-1.5 text-[12.5px] text-white/45">
                Recorded request cost in the selected range. Rolling caps are shown below.
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] tracking-[0.14em] text-white/45 uppercase">credits remaining</div>
              <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-brand-ember">
                 ${Number(balance || 0).toFixed(2)}
              </div>
            </div>
          </div>
          <a href="#/dashboard/logs" className="mt-5 inline-block text-[12.5px] text-brand-ember underline underline-offset-4">
            Open full usage log
          </a>
        </Panel>

        <Panel title="Plan" subtitle={session.plan}>
          <div className="space-y-3 text-[12.5px] text-white/60">
            <div className="flex items-center justify-between">
              <span>Credit balance</span>
              <span className="font-mono text-white/85">${Number(balance).toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Spent ({period})</span>
              <span className="font-mono text-white/85">{spentLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Requests</span>
              <span className="font-mono text-white/85">{ws?.summary ? Number(ws.summary.requests).toLocaleString() : "?"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Tokens</span>
              <span className="font-mono text-white/85">{ws?.summary ? (Number(ws.summary.tokens_in) + Number(ws.summary.tokens_out)).toLocaleString() : "?"}</span>
            </div>
          </div>
          <a href="#/pricing" className="mt-5 block w-full rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-4 py-2.5 text-center text-[12.5px] font-medium text-white">
            See plans & pricing
          </a>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Spend by model" subtitle={`${period} / loaded request rows`} bodyClassName="overflow-x-auto p-0">
          <table className="w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="border-b border-white/8">
                {["Model", "Share", "Tokens", "Cost"].map((h, i) => (
                  <th key={h} className={cn("px-5 py-3 font-mono text-[10px] font-normal tracking-[0.16em] text-white/40 uppercase", i > 1 ? "text-right" : "text-left")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
               {usageRows.length === 0 ? (
                 <tr>
                   <td colSpan={4} className="px-5 py-10 text-center text-[12.5px] text-white/45">
                     No usage recorded in this window yet.
                   </td>
                 </tr>
               ) : null}
               {usageRows.map((u) => (
                 <tr key={u.label} className="border-b border-white/5 last:border-0">
                  <td className="px-5 py-3.5 text-[13px] text-white/80">{u.label}</td>
                  <td className="w-[38%] px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Bar pct={u.share * 2} color="#C79A1E" />
                      <span className="font-mono text-[11px] text-white/50">{u.share}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono text-[11.5px] tabular-nums text-white/70">{u.tokens}</td>
                  <td className="px-5 py-3.5 text-right font-mono text-[11.5px] tabular-nums text-white/85">${u.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Credit ledger" subtitle="recorded balance adjustments">
          <ul className="divide-y divide-white/6">
            {invoiceRows.length === 0 ? (
              <li className="py-6 text-center text-[12.5px] text-white/45">No ledger entries yet.</li>
            ) : null}
            {invoiceRows.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 py-3.5 first:pt-0">
                <div>
                  <div className="font-mono text-[12px] text-white/85">{inv.id}</div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-white/35">
                    {inv.date} Â· {inv.plan}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[12.5px] text-white/85">{inv.amount}</span>
                  <span className="rounded-full border border-lime-400/25 bg-lime-500/10 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.14em] text-lime-300 uppercase">
                    {inv.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Spend windows" subtitle="rolling caps the gateway enforces per account">
          {(() => {
            const w = ws?.windows;
            const rows = w
              ? [
                  { label: "Weekly window", used: Number(w.weekly_used_usd) || 0, cap: Number(w.weekly_limit_usd) || 0 },
                  { label: "5-hour window", used: Number(w.five_hour_used_usd) || 0, cap: Number(w.five_hour_limit_usd) || 0 },
                ]
              : [];
            if (!rows.length) {
              return (
                <p className="py-6 text-[12.5px] leading-relaxed text-white/45">
                  Spend-window information is unavailable. Refresh to retry; limits cannot be inferred from missing data.
                </p>
              );
            }
            return (
              <div className="space-y-4">
                {rows.map((r, i) => (
                  <div key={r.label}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-mono text-[12px] text-white/70">{r.label}</span>
                      <span className="font-mono text-[11px] tabular-nums text-white/50">
                        {r.cap > 0 ? `$${r.used.toFixed(2)} of $${r.cap.toFixed(2)}` : `$${r.used.toFixed(2)} Â· no cap`}
                      </span>
                    </div>
                    <Bar pct={r.cap > 0 ? Math.min(100, (r.used / r.cap) * 100) : 4} color={r.cap > 0 && r.used / r.cap > 0.8 ? "#E23D28" : "#2447E8"} delay={i * 70} />
                  </div>
                ))}
              </div>
            );
          })()}
        </Panel>

        <Panel title="Budgets & limits" subtitle="alerts fire at 80% of each threshold">
          <ul className="divide-y divide-white/6">
            {(() => {
              const rows = [];
              const w = ws?.windows;
              if (Number(w?.weekly_limit_usd) > 0) {
                const used = Number(w.weekly_used_usd) || 0;
                const capW = Number(w.weekly_limit_usd);
                rows.push({ k: "Weekly spend window", v: `$${used.toFixed(2)} / $${capW.toFixed(2)}`, pct: (used / capW) * 100 });
              }
              if (Number(w?.five_hour_limit_usd) > 0) {
                const used = Number(w.five_hour_used_usd) || 0;
                const capF = Number(w.five_hour_limit_usd);
                rows.push({ k: "5-hour spend window", v: `$${used.toFixed(2)} / $${capF.toFixed(2)}`, pct: (used / capF) * 100 });
              }
              if (ws?.summary) {
                const reqs = Number(ws.summary.requests) || 0;
                const failed = Number(ws.summary.failed) || 0;
                rows.push({ k: "Failed requests", v: `${failed.toLocaleString()} / ${reqs.toLocaleString()}`, pct: reqs ? (failed / reqs) * 100 : 0 });
              }
              return rows;
            })().map((b, i) => (
              <li key={b.k} className="py-3.5 first:pt-0">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12.5px] text-white/70">{b.k}</span>
                  <span className="font-mono text-[11.5px] tabular-nums text-white/60">{b.v}</span>
                </div>
                <Bar pct={b.pct} color={b.pct > 85 ? "#E23D28" : "#0D7A66"} delay={i * 70} />
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function SettingsView({ session }) {
  /* Real catalog ids in the model picker â€” a saved preference that names a
     model the gateway does not serve would be a broken default. */
  const catalog = useCatalog();
  const catalogRows = catalog ?? models;
  const [defaultModel, setDefaultModel] = useState(() => catalogRows[0]?.id ?? "");
  const [policy, setPolicy] = useState("auto:balanced");
  const [maxTokens, setMaxTokens] = useState(1024);
  const [retention, setRetention] = useState(false);


  useEffect(() => {
    setDefaultModel((cur) =>
      catalogRows.some((m) => m.id === cur) ? cur : (catalogRows[0]?.id ?? ""),
    );
  }, [catalog]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-4">
        {/* First, because a gated workspace cannot make a single API call
            until this is satisfied — and this screen is the only live place
            to do it. Panel is passed in rather than imported by the child, so
            the two files do not import each other. */}
        <DiscordPanel Panel={Panel} />

        <Panel title="Organization" subtitle="visible to everyone in your workspace">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { k: "Organization name", v: session.org.charAt(0).toUpperCase() + session.org.slice(1) },
              { k: "Billing email", v: `billing@${session.email.split("@")[1]}` },
              { k: "Primary contact", v: session.name },
              { k: "Account id", v: `org_${session.email.split("@")[0]}` },
            ].map((f) => (
              <label key={f.k} className="block">
                <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{f.k}</span>
                <input
                  defaultValue={f.v}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-2.5 text-[13px] text-white focus:border-brand-ember/60 focus:outline-none"
                />
              </label>
            ))}
          </div>
        </Panel>

        <Panel title="Request defaults" subtitle="applied when a request omits these fields">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">default model</span>
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-2.5 text-[13px] text-white focus:outline-none"
              >
                {catalogRows.map((m) => (
                  <option key={m.id} value={m.id} className="bg-ink-900">
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">routing policy</span>
              <select
                value={policy}
                onChange={(e) => setPolicy(e.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-2.5 text-[13px] text-white focus:outline-none"
              >
                {["auto:balanced", "auto:cheapest", "auto:fastest"].map((r) => (
                  <option key={r} className="bg-ink-900">
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">max output tokens</span>
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                className="mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-2.5 text-[13px] text-white focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-4 rounded-xl border border-white/8 bg-white/[0.03] p-3.5 font-mono text-[11px] text-white/45">
            effective config Â· model={defaultModel} Â· region=auto Â· max_tokens={maxTokens}
          </div>
        </Panel>

        <Panel title="Data & privacy">
          <div className="space-y-4">
            {[
              {
                k: "Zero-retention mode",
                d: "Prompts and completions are discarded immediately after the response is streamed.",
                on: retention,
                set: setRetention,
              },
              {
                k: "Training on your data",
                d: "Locked off for Scale and Enterprise accounts. Your traffic never trains shared models.",
                on: false,
                set: () => {},
                locked: true,
              },
            ].map((row) => (
              <div key={row.k} className="flex items-start justify-between gap-6 rounded-xl border border-white/8 bg-white/[0.025] p-4">
                <div>
                  <div className="text-[13px] font-medium text-white/90">{row.k}</div>
                  <p className="mt-1 max-w-md text-[12px] leading-relaxed text-white/45">{row.d}</p>
                </div>
                {row.locked ? (
                  <span className="shrink-0 rounded-full border border-lime-400/25 bg-lime-500/10 px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-lime-300 uppercase">
                    enforced
                  </span>
                ) : (
                  <Switch on={row.on} onChange={row.set} label={row.k} />
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="Danger zone">
          <p className="text-[12.5px] leading-relaxed text-white/50">
            Deleting the organization revokes every API key, stops all fine-tune jobs and removes
            stored embeddings after 30 days.
          </p>
          <button className="mt-4 w-full rounded-full border border-rose-400/30 bg-rose-500/[0.1] px-4 py-2.5 text-[12.5px] text-rose-100 transition-colors hover:bg-rose-500/20">
            Delete organization
          </button>
        </Panel>
      </div>
    </div>
  );
}

function Overview({ range, query, navigate, ws }) {
  /* Live dataset from my_usage_series + my_usage_summary; the kit's
     deterministic series until the gateway answers. */
  /* `null` rather than a generated dataset: the charts render a loading state
     until real telemetry arrives instead of drawing invented curves. */
  const data = useMemo(() => ws?.dataset ?? null, [ws?.dataset, range]);
  const alertRows = ws?.alerts ?? [];
  const activityRows = ws?.activity ?? [];
  const [metric, setMetric] = useState("requests");

  /* Model mix: real per-model request share from the loaded window. Offline
     / not configured, this panel admits it instead of inventing percentages. */
  const mix = ws?.live ? ws?.usageByModel ?? [] : null;
  const mixColors = ["#2447E8", "#C79A1E", "#E23D28", "#0D7A66", "#1630B8", "#8c1b0b"];

  const series = useMemo(() => {
    if (!data) return [];
    if (metric === "requests") return [{ id: "r", name: "Requests (k)", color: "#2447E8", values: data.requests }];
    if (metric === "tokens")
      return [
        { id: "t", name: "Tokens (M)", color: "#C79A1E", values: data.tokens.map((t) => Number((t / 1_000_000).toFixed(2))) },
        { id: "in", name: "Input only (M)", color: "#2447E8", values: data.tokens.map((t) => Number((t / 1_450_000).toFixed(2))) },
      ];
    if (metric === "latency") return [{ id: "l", name: ws?.dataset ? "Latency (ms)" : "TTFT p50 (ms)", color: "#E23D28", values: data.latency }];
    return [{ id: "s", name: "Spend ($)", color: "#0D7A66", values: data.spend }];
  }, [metric, data, ws?.dataset]);

  /* No telemetry yet — the account's numbers, or nothing. There is deliberately
     no generated series to fall back on, so this is what an empty window looks
     like rather than invented curves that change a moment later. */
  if (!data) {
    return (
      <div className="space-y-4">
        <Panel title="Traffic & cost" subtitle={`${range} window`}>
          <div className="grid place-items-center py-20 text-center">
            <p className="text-[13px] text-white/55">Loading telemetry for this window…</p>
            <p className="mt-1.5 text-[12px] text-white/35">
              Charts appear as soon as the gateway reports usage.
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {data.kpis.map((k, i) => (
          <KpiCard
            key={k.id}
            kpi={k}
            invert={k.id === "error" || k.id === "latency"}
            spark={k.id === "latency" ? data.latency : data[k.id === "spend" ? "spend" : k.id === "error" ? "latency" : k.id] ?? data.requests}
            color={["#2447E8", "#C79A1E", "#E23D28", "#1630B8", "#0D7A66"][i % 5]}
          />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Panel
          title="Traffic & cost"
          subtitle={`${range} window${ws?.live ? " Â· live" : ""} Â· hover the chart for exact samples`}
          action={
            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
              {["requests", "tokens", "latency", "spend"].map((m) => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={cn(
                    "rounded-full px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors",
                    metric === m ? "bg-white/90 text-ink-950" : "text-white/50 hover:text-white",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-4">
            {series.map((s) => (
              <span key={s.id} className="flex items-center gap-2 text-[11.5px] text-white/55">
                <span className="h-1.5 w-4 rounded-full" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
          <AreaChart series={series} labels={data.labels} height={272} format={(v) => v.toFixed(1)} />
        </Panel>

        <div className="space-y-4">
          <Panel title="Quick actions">
            <div className="grid gap-2.5">
              {[
                { l: "Open playground", d: "Test a prompt with any model", p: "dashboard/playground" },
                { l: "Create an API key", d: "Scope and rotate secrets", p: "dashboard/keys" },
                { l: "Compare models", d: "Latency vs price vs context", p: "dashboard/models" },
              ].map((a) => (
                <button
                  key={a.l}
                  onClick={() => navigate(a.p)}
                  className="group flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-brand-ember/35"
                >
                  <span>
                    <span className="block text-[13px] text-white/85">{a.l}</span>
                    <span className="block font-mono text-[10.5px] text-white/40">{a.d}</span>
                  </span>
                  <span className="text-white/35 transition-transform group-hover:translate-x-0.5">â†’</span>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Model mix"
          subtitle={ws?.live ? `share of requests Â· ${range}` : "needs a connected gateway"}
        >
          {mix === null ? (
            <p className="py-6 text-[12.5px] leading-relaxed text-white/45">
              Real per-model share renders here once the gateway is configured and has served
              requests â€” the console does not invent a split.
            </p>
          ) : mix.length === 0 ? (
            <p className="py-6 text-[12.5px] text-white/45">No requests in this window yet.</p>
          ) : (
            <div className="space-y-4">
              {mix.map((m, i) => (
                <div key={m.label}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-[12px] text-white/70">{m.label}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/50">{m.share}%</span>
                  </div>
                  <Bar pct={m.share} color={mixColors[i % mixColors.length]} delay={i * 80} />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Budget alerts" subtitle="thresholds you configured">
          <div className="space-y-3">
            {alertRows.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-white/45">
                Nothing is close to a threshold.
              </p>
            ) : null}
            {alertRows.map((a) => {
              const warn = a.level === "near limit";
              return (
                <div
                  key={a.label}
                  className={cn(
                    "flex items-center justify-between gap-4 rounded-xl border px-3.5 py-3",
                    warn ? "border-amber-400/25 bg-amber-500/[0.07]" : "border-white/8 bg-white/[0.03]",
                  )}
                >
                  <span>
                    <span className="block text-[12.5px] text-white/80">{a.label}</span>
                    <span className={cn("font-mono text-[10.5px]", warn ? "text-amber-200" : "text-white/40")}>{a.level}</span>
                  </span>
                  <span className="font-mono text-[12.5px] tabular-nums text-white/85">{a.value}</span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Activity and failover log">
          <ol className="relative space-y-4 before:absolute before:top-1 before:bottom-1 before:left-[3.5px] before:w-px before:bg-white/8">
            {activityRows.length === 0 ? (
              <li className="text-[12.5px] text-white/45">No requests in this window yet.</li>
            ) : null}
            {activityRows.map((a, i) => {
              const tone = {
                ember: "bg-brand-ember",
                lime: "bg-lime-400",
                gold: "bg-brand-gold",
                coral: "bg-brand-coral",
              };
              return (
                <li key={i} className="relative flex gap-4">
                  <span className={cn("relative z-10 mt-1.5 h-2 w-2 shrink-0 rounded-full", tone[a.tone] ?? "bg-white/40")} />
                  <span className="text-[12.5px] leading-relaxed text-white/60">
                    <span className="text-white/90">{a.who}</span> {a.action}{" "}
                    <span className="font-mono text-[11.5px] text-brand-ember">{a.target}</span>
                    <span className="ml-2 font-mono text-[10.5px] text-white/30">{a.time} ago</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </Panel>
      </div>

      <Panel
        title="Recent requests"
        subtitle={`newest first / last ${ws?.days ?? 1}d`}
        action={
          <a href="#/dashboard/logs" className="font-mono text-[11px] text-brand-ember underline underline-offset-4">
            Full usage log
          </a>
        }
        bodyClassName="p-0"
      >
        <RequestsTable query={query} ws={ws} />
      </Panel>
    </div>
  );
}

export default function Dashboard({
  session,
  view,
  navigate,
  onExit,
  onSignOut,
  playgroundModel,
  /* The rs_live_ key carried over from the Keys view's reveal dialog. Lives
     in RageStarApp (not here) because this component remounts on every view
     change — the page-enter key in RageStarApp.jsx — so local state set right
     before a keys → playground navigation would be thrown away with the old
     instance. RageStarApp persists across view changes, like the old
     Workspace shell's presetKey. */
  playgroundKey = "",
  onUseInPlayground,
  isStaff = false,
}) {
  const [range, setRange] = useState(view === "usage" || view === "logs" ? "30d" : "24h");
  const [query, setQuery] = useState("");
  const [modelForPlayground, setModelForPlayground] = useState(playgroundModel);

  /* One live usage source for every panel, keyed to the range picker. */
  const ws = useWorkspace(range);

  useEffect(() => {
    if (playgroundModel) setModelForPlayground(playgroundModel);
  }, [playgroundModel]);

  useEffect(() => {
    setQuery("");
  }, [view]);

  const title = navItems.find((n) => n.id === view)?.label ?? "Overview";

  return (
    <div className="relative min-h-screen text-[#101814]">
      <div className="relative z-10 flex">
        {/* sidebar */}
        <aside className="fixed inset-y-0 left-0 hidden w-[252px] flex-col border-r border-white/8 bg-ink-900/70 px-4 py-5 backdrop-blur-xl lg:flex">
          <button onClick={onExit} className="flex items-center gap-3 px-1 text-left">
            <span className="pr-brand-mark relative grid h-9 w-9 place-items-center">
              <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90" />
              <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
                <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                <path d="M12 3.2v16.2" stroke="currentColor" strokeWidth="0.9" opacity="0.6" />
              </svg>
            </span>
            <span className="leading-tight">
              <span className="font-display block text-[14px] font-semibold tracking-tight text-white">RageStar</span>
              <span className="block font-mono text-[9.5px] tracking-[0.2em] text-white/40 uppercase">console</span>
            </span>
          </button>

          <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
            <span className="flex items-center justify-between font-mono text-[9.5px] tracking-[0.18em] text-white/40 uppercase">
              workspace
              <DotmSquare1 size={12} dotSize={2} color="#2447E8" speed={1} aria-hidden />
            </span>
            <span className="block truncate text-[12.5px] text-white/85">
              {session.org.charAt(0).toUpperCase() + session.org.slice(1)}
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-white/35">{session.plan} plan</span>
          </div>

          <nav className="mt-6 space-y-1">
            {navItems.map((n) => (
              <button
                key={n.id}
                onClick={() => navigate(`dashboard/${n.id}`)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-300",
                  view === n.id
                    ? "border border-orange-400/25 bg-gradient-to-r from-orange-500/16 to-transparent text-white"
                    : "border border-transparent text-white/55 hover:bg-white/[0.04] hover:text-white/90",
                )}
              >
                <Icon path={n.icon} className={cn("h-4 w-4", view === n.id && "text-brand-ember")} />
                {n.label}
                {n.id === "usage" && (
                  <span className="ml-auto font-mono text-[9.5px] text-white/35">
                    {ws?.summary ? `$${Number(ws.summary.cost_usd).toFixed(2)}` : "—"}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-6 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[9.5px] tracking-[0.18em] text-white/40 uppercase">credits</span>
              <span className="font-mono text-[10.5px] text-white/60">
                ${Number(ws?.credits?.credit_balance_usd ?? session.credits).toFixed(0)}
              </span>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-white/40">
              Metered per request Â· topped up from the console
            </p>
          </div>

          {isStaff && (
            <div className="mt-6 border-t border-white/8 pt-4">
              <p className="px-3 pb-2 font-mono text-[9px] tracking-[0.26em] text-white/30 uppercase">staff</p>
              <button
                onClick={() => navigate("admin")}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-white/55 transition-colors hover:bg-white/[0.04] hover:text-white"
              >
                <Icon
                  path="M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6l7-3Zm-1.6 11.4 4-4"
                  className="text-brand-coral"
                />
                Admin console
                <span className="ml-auto rounded-full border border-brand-coral/30 bg-brand-coral/10 px-2 py-0.5 font-mono text-[9px] tracking-[0.12em] text-rose-200 uppercase">
                  staff
                </span>
              </button>
            </div>
          )}

          <div className="mt-auto space-y-1 pt-6">
            <button
              onClick={onExit}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-white/55 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              <Icon path="M19 12H5M11 18l-6-6 6-6" />
              Back to site
            </button>
            <button
              onClick={onSignOut}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-white/55 transition-colors hover:bg-white/[0.04] hover:text-white"
            >
              <Icon path="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M13 8l4 4-4 4M17 12H9" />
              Sign out
            </button>
            <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-orange-500 to-rose-500 font-display text-[12px] font-semibold text-white">
                {session.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-white/85">{session.name}</span>
                <span className="block truncate font-mono text-[10px] text-white/40">{session.email}</span>
              </span>
            </div>
          </div>
        </aside>

        {/* main */}
        <div className="min-w-0 flex-1 lg:pl-[252px]">
          <header className="pr-glass-strong sticky top-0 z-30 flex flex-wrap items-center gap-3 px-4 py-3.5 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 lg:hidden">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none">
                  <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <h1 className="font-display text-[17px] font-semibold tracking-tight text-white">{title}</h1>
                <p className="font-mono text-[10px] tracking-[0.16em] text-white/40 uppercase">
                  org Â· {session.org} Â· {API_HOST}
                </p>
              </div>
            </div>

            <div className="relative order-3 w-full sm:order-none sm:ml-auto sm:w-64">
              <Icon
                path="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.5-4.5"
                className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-white/35"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={view === "models" ? "Search modelsâ€¦" : "Search requests, idsâ€¦"}
                className="w-full rounded-full border border-white/10 bg-white/[0.05] py-2.5 pr-3 pl-9 text-[12.5px] text-white placeholder:text-white/35 focus:border-brand-ember/60 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
              {ranges.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    "rounded-full px-3 py-1.5 font-mono text-[10.5px] tracking-[0.12em] transition-all duration-300",
                    range === r.id ? "bg-[#101814] text-ink-950" : "text-white/50 hover:text-white",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* Manual refresh for the live workspace. The panels' empty states
                say "Use Refresh to retry" — this is that button, next to the
                range selector it applies to. */}
            <button
              onClick={() => ws?.refresh?.()}
              className="rounded-full border border-white/12 bg-white/[0.04] px-3.5 py-1.5 font-mono text-[10.5px] tracking-[0.14em] text-white/60 uppercase transition-colors hover:bg-white/[0.08] hover:text-white"
              title="Reload keys, logs, usage and credits now"
            >
              Refresh
            </button>

            <button
              onClick={() => navigate("dashboard/keys")}
              className="hidden rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-4 py-2.5 text-[12.5px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)] sm:block"
            >
              New API key
            </button>
          </header>

          <div className="flex gap-2 overflow-x-auto border-b border-white/8 px-4 py-3 lg:hidden">
            {navItems.map((n) => (
              <button
                key={n.id}
                onClick={() => navigate(`dashboard/${n.id}`)}
                className={cn(
                  "shrink-0 rounded-full border px-3.5 py-2 font-mono text-[10.5px] tracking-[0.14em] uppercase transition-colors",
                  view === n.id
                    ? "border-orange-400/30 bg-orange-500/12 text-orange-100"
                    : "border-white/10 bg-white/[0.03] text-white/50",
                )}
              >
                {n.label}
              </button>
            ))}
          </div>

          <main className="space-y-4 p-4 sm:p-6">
            {ws?.error ? (
              <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                Could not load live workspace data â€” showing sample data. {ws.error}
              </p>
            ) : null}

            {view === "overview" && <Overview range={range} query={query} navigate={navigate} ws={ws} />}

            {view === "models" && (
              <ModelCatalog
                onTry={(id) => {
                  setModelForPlayground(id);
                  navigate("dashboard/playground");
                }}
              />
            )}

            {/* The workspace goes in so a live call can refresh the log and
                usage panels. Without it the request was recorded but the
                screens kept showing the state from before it. */}
            {view === "playground" && (
              <Playground initialModel={modelForPlayground} initialKey={playgroundKey} ws={ws} />
            )}

            {view === "keys" && <KeysView ws={ws} onUseInPlayground={onUseInPlayground} />}

            {view === "usage" && <UsageView session={session} ws={ws} />}

            {/* The full usage log — the spreadsheet every "Full usage log" /
                "Open full usage log" link and the sidebar's Usage logs item
                point at. It used to have no render case, so the deep link
                #/dashboard/logs opened an empty canvas. Same panel, same
                live workspace, same columns as the old console's Usage tab. */}
            {view === "logs" && <UsageLogs ws={ws} query={query} />}

            {/* The community portal. #/community and #/chat have redirected
                here since #/console was retired, but no view ever rendered it,
                so the header's Community link landed on Overview. The panel
                brings its own .wk-community.cmx scope, so it drops straight in
                without the workspace shell it used to live in. */}
            {view === "community" && <CommunityPanel />}

            {view === "settings" && (
              <div className="space-y-4">
                <SettingsView session={session} />
              </div>
            )}
          </main>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 px-4 py-5 sm:px-6">
            <p className="font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
              console v3.0 Â· {models.length} models available Â· {API_HOST}
            </p>
            <p className="font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
              need help?{" "}
              <a href="#/docs" className="text-white/55 underline decoration-white/25 underline-offset-4 hover:text-brand-ember">docs</a>
              {" Â· "}
              <a href="#/status" className="text-white/55 underline decoration-white/25 underline-offset-4 hover:text-brand-ember">status</a>
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
