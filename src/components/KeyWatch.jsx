/* ==========================================================================
   KeyWatch — v11.1
   --------------------------------------------------------------------------
   The beat lives on the server (supabase/functions/keywatch, fired by pg_cron
   inside Supabase itself as of v11.3). This card is its control surface and
   its window:

     · switch the server beat on or off, pick the interval and batch size
     · see the last pass, the countdown to the next, and what it found
     · be told plainly when the beat has gone quiet — and WHICH of the four
       things is wrong, instead of a generic "check your cron"

   v11.1 changed two things about how this card talks:

   1. DIAGNOSE. The old card printed one sentence covering four completely
      different faults (not deployed / JWT verification on / secret missing /
      secret mismatch). Every one of them produces "last pass never", so that
      sentence could not help. There is now a button that asks the function
      itself and names the actual fault, with the command to fix it.

   2. HONESTY. The old card shouted "stalled" in red even while the tab
      fallback was successfully checking keys — you could read "no pass has
      landed" directly above "30 checked · 29 ok". The server beat and the tab
      loop are now reported as two separate facts, because they are.

   RULES OF HOOKS: every hook in this file is called unconditionally, in one
   block, before any return. Do not move one below a `return` — that is the
   exact bug that took the admin panel down in v11.0.

   Props are unchanged, so existing call sites keep working:
     onRun          async () => result   — the manual/local check
     defaultSeconds number                — local loop interval
     storageKey     string                — where the local loop remembers itself
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getKeywatchStatus,
  saveKeywatchSettings,
  pingKeywatchFn,
  KEYWATCH_UPGRADE_FILE,
} from "../lib/db.js";
import { relative } from "../lib/format.js";

const CHOICES = [15, 30, 60, 300];
const MAX_FAILS = 3;
const POLL_MS = 5000;

function pad(n) {
  return String(Math.max(0, Math.round(n)));
}

export default function KeyWatch({ onRun, defaultSeconds = 15, storageKey = "ragestar-keywatch" }) {
  /* =======================================================================
     HOOKS — all of them, unconditionally, before any return.
     ======================================================================= */

  /* ---------------------------------------------------------- server side */
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [saving, setSaving] = useState("");
  const [now, setNow] = useState(() => Date.now());

  /* ----------------------------------------------------------- local loop */
  const [localOn, setLocalOn] = useState(false);
  const [localEvery, setLocalEvery] = useState(defaultSeconds);
  const [out, setOut] = useState(null);
  const [localAt, setLocalAt] = useState(0);
  const [err, setErr] = useState("");
  const [fails, setFails] = useState(0);
  const [running, setRunning] = useState(false);
  const busy = useRef(false);

  /* ----------------------------------------------------------- diagnostics */
  const [diag, setDiag] = useState(null);
  const [diagBusy, setDiagBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getKeywatchStatus();
      setStatus(next);
      setStatusError("");
      return next;
    } catch (e) {
      setStatusError(String(e?.message || e));
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    const tick = async () => {
      if (!alive) return;
      /* A background tab polling every five seconds is just noise on someone
         else's database; the countdown resumes the moment it is looked at. */
      if (typeof document !== "undefined" && document.hidden) return;
      await refresh();
    };

    tick();
    timer = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        setLocalOn(Boolean(saved.on));
        if (CHOICES.includes(Number(saved.every))) setLocalEvery(Number(saved.every));
      }
    } catch {
      /* no storage: the local loop just starts off */
    }
  }, [storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ on: localOn, every: localEvery }));
    } catch {
      /* ignored */
    }
  }, [storageKey, localOn, localEvery]);

  const patch = useCallback(async (body, tag) => {
    setSaving(tag);
    try {
      const next = await saveKeywatchSettings(body);
      setStatus(next);
      setStatusError("");
    } catch (e) {
      setStatusError(String(e?.message || e));
    } finally {
      setSaving("");
    }
  }, []);

  const runOnce = useCallback(async () => {
    if (busy.current || typeof onRun !== "function") return;
    busy.current = true;
    setRunning(true);
    try {
      const result = await onRun();
      setOut(result || null);
      setLocalAt(Date.now());
      setErr("");
      setFails(0);
    } catch (e) {
      setErr(String(e?.message || e));
      setFails((n) => n + 1);
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }, [onRun]);

  useEffect(() => {
    if (!localOn) return undefined;
    /* Repeated failures stop the loop instead of hammering a dead upstream
       once a second until someone notices the console. */
    if (fails >= MAX_FAILS) {
      setLocalOn(false);
      return undefined;
    }
    const timer = window.setInterval(runOnce, Math.max(5, localEvery) * 1000);
    runOnce();
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localOn, localEvery, fails]);

  /* Ask the function itself what is wrong. This is the only check that can
     tell the four faults apart, because each one answers differently:
       404          → never deployed
       401          → deployed behind JWT verification
       200 + false  → deployed, but Supabase has no KEYWATCH_CRON_SECRET
       200 + true   → function is fine, so the fault is in the pg_cron schedule */
  const diagnose = useCallback(async () => {
    setDiagBusy(true);
    setDiag(null);
    try {
      const r = await pingKeywatchFn();
      let verdict;
      let fix = null;

      if (r.status === 0) {
        verdict = "The browser could not reach the function at all.";
        fix = "Check VITE_SUPABASE_URL in .env, then restart the dev server.";
      } else if (r.status === 404) {
        verdict = "The keywatch function is NOT deployed on this project.";
        fix = "supabase functions deploy keywatch --no-verify-jwt";
      } else if (r.status === 401) {
        verdict =
          "The function is deployed, but Supabase is rejecting calls before it runs " +
          "(JWT verification is on). This is what stops the scheduled call.";
        fix = "supabase functions deploy keywatch --no-verify-jwt";
      } else if (r.secret_set === false) {
        verdict =
          "The function is deployed and reachable, but it has no cron secret, so it " +
          "refuses every scheduled call with 403.";
        fix = 'supabase secrets set KEYWATCH_CRON_SECRET="<a long random string>"';
      } else if (r.ok) {
        /* v11.3: there is no third party left to blame. If the function is
           healthy, the only remaining link is the pg_cron job in this same
           database — and unlike the old worker, it keeps a readable log of
           every firing and the reply it got back. */
        verdict =
          "The function is deployed, reachable and has its cron secret. " +
          "So the fault is in the schedule: either keywatch_schedule() was never " +
          "called, or the job exists and its calls are being refused.";
        fix = "select public.keywatch_cron_log(10);";
      } else {
        verdict = `The function answered ${r.status}. ${r.message || ""}`.trim();
        fix = "supabase functions logs keywatch";
      }

      setDiag({ ...r, verdict, fix });
    } catch (e) {
      setDiag({ ok: false, verdict: String(e?.message || e), fix: null });
    } finally {
      setDiagBusy(false);
    }
  }, []);

  const summary = useMemo(() => {
    if (!out) return null;
    const results = out.results || [];
    const ok = results.filter((r) => r.ok).length;
    return { checked: results.length, ok, bad: results.length - ok };
  }, [out]);

  /* =======================================================================
     DERIVED VALUES — plain consts, no hooks past this point.
     ======================================================================= */

  const server = status?.settings || null;
  const installed = status?.installed === true;
  const every = Number(server?.interval_seconds) || defaultSeconds;
  const lastRunAt = status?.last_run_at ? new Date(status.last_run_at).getTime() : 0;
  const sinceRun = lastRunAt ? (now - lastRunAt) / 1000 : null;
  const nextIn = sinceRun === null ? null : Math.max(0, every - sinceRun);

  /* Three missed passes is the point where "a little late" becomes "nothing is
     running": cron jitter is seconds, a dead worker is minutes. */
  const stale = Boolean(server?.enabled) && (sinceRun === null || sinceRun > every * 3);
  /* "never" and "it stopped" are different problems with different fixes, so
     the card no longer collapses them into one sentence. */
  const neverRan = Boolean(server?.enabled) && sinceRun === null;

  /* Is the tab fallback actually keeping keys fresh right now? If so the card
     must not claim nothing is being checked. */
  const localFresh =
    localOn && localAt > 0 && (now - localAt) / 1000 < Math.max(5, localEvery) * 3;

  const health = status?.keys?.by_status || {};
  const working = Number(health.working || 0);
  const failing =
    Number(health.failing || 0) + Number(health.expired || 0) + Number(health.rate_limited || 0);
  const unknown = Number(health.unknown || 0);

  const dotState = !installed
    ? "off"
    : stale
      ? localFresh
        ? "stale"
        : "stale"
      : server?.enabled
        ? "live"
        : "off";

  return (
    <div className="kw">
      <div className="kw-top">
        <span className={`kw-dot ap-dot is-${dotState}`} aria-hidden="true" />
        <div>
          <div className="kw-title">Key watch</div>
          <div className="kw-sub">
            {!installed
              ? `Server beat not installed — run supabase/${KEYWATCH_UPGRADE_FILE}`
              : server?.enabled
                ? stale
                  ? localFresh
                    ? "Server beat is not landing — this tab is covering for it"
                    : neverRan
                      ? "Switched on, but no pass has ever landed"
                      : "Switched on, but the beat has stopped"
                  : `Running on the server every ${every}s — the tab can be closed`
                : "Switched off — keys are only checked when you ask"}
          </div>
        </div>

        <div className="kw-controls">
          <button
            type="button"
            className="ap-chip"
            aria-pressed={Boolean(server?.enabled)}
            disabled={!installed || saving === "toggle"}
            onClick={() => patch({ enabled: !server?.enabled }, "toggle")}
          >
            {saving === "toggle" ? "…" : server?.enabled ? "Server watch on" : "Server watch off"}
          </button>

          <label className="kw-every">
            <span>every</span>
            <select
              className="kw-select"
              value={every}
              disabled={!installed || saving === "interval"}
              onChange={(e) => patch({ interval_seconds: Number(e.target.value) }, "interval")}
            >
              {CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s}s` : `${s / 60}m`}
                </option>
              ))}
            </select>
          </label>

          <button type="button" className="ap-chip" disabled={running} onClick={runOnce}>
            {running ? "Checking…" : "Check now"}
          </button>

          <button type="button" className="ap-chip" disabled={diagBusy} onClick={diagnose}>
            {diagBusy ? "Testing…" : "Diagnose"}
          </button>
        </div>
      </div>

      {installed ? (
        <div className="kw-server">
          <span className={`kw-pill ${server?.enabled ? (stale ? "is-stale" : "is-on") : "is-off"}`}>
            {server?.enabled ? (stale ? "stalled" : "live") : "paused"}
          </span>
          <span>
            last pass{" "}
            {status?.last_run_at ? relative(status.last_run_at) : "never"}
            {status?.last_run?.checked !== undefined && !status?.last_run?.skipped
              ? ` · ${status.last_run.checked} checked`
              : ""}
          </span>
          {server?.enabled && nextIn !== null ? <span>next in {pad(nextIn)}s</span> : null}
          <span>
            {working} working · {failing} failing · {unknown} untested
          </span>
          <span>batch {server?.batch_size ?? 25}</span>
          {status?.keys?.stale ? <span>{status.keys.stale} keys not checked lately</span> : null}
          {localFresh ? <span className="kw-pill is-on">tab fallback active</span> : null}
        </div>
      ) : null}

      {/* The generic "check your cron" line is gone. It described four
          different faults at once and could not tell you which you had. */}
      {stale ? (
        <div className={localFresh ? "kw-msg" : "kw-msg kw-err"}>
          {localFresh ? (
            <>
              Your keys <b>are</b> being checked — but by this browser tab, not by the server, so
              it stops the moment you close it.{" "}
            </>
          ) : null}
          The server beat is on but the last pass was{" "}
          {sinceRun === null ? "never" : `${pad(sinceRun)}s ago`}. Press{" "}
          <b>Diagnose</b> and it will name the exact cause.
        </div>
      ) : null}

      {diag ? (
        <div className={diag.ok ? "kw-msg" : "kw-msg kw-err"}>
          <div>
            <b>Diagnosis:</b> {diag.verdict}
          </div>
          {diag.fix ? (
            <div className="kw-fix">
              Run this: <code>{diag.fix}</code>
            </div>
          ) : null}
          <div className="kw-diag-meta">
            HTTP {diag.status ?? "—"} · {diag.elapsed ?? "—"}ms · deployed{" "}
            {diag.deployed ? "yes" : "no"} · secret{" "}
            {diag.secret_set === null || diag.secret_set === undefined
              ? "unknown"
              : diag.secret_set
                ? "set"
                : "missing"}
          </div>
        </div>
      ) : null}

      {status?.last_error ? (
        <div className="kw-msg kw-err">Last server error: {status.last_error}</div>
      ) : null}
      {statusError ? <div className="kw-msg kw-err">{statusError}</div> : null}

      {/* The v10 behaviour, kept deliberately: on a database without the v11
          upgrade this is still the only way to watch keys. */}
      <div className="kw-meta">
        <label className="ap-field">
          <input
            type="checkbox"
            checked={localOn}
            onChange={(e) => {
              setFails(0);
              setLocalOn(e.target.checked);
            }}
          />
          <span>Also watch from this tab {installed ? "(fallback)" : ""}</span>
        </label>
        {localOn ? (
          <label className="kw-every">
            <span>every</span>
            <select
              className="kw-select"
              value={localEvery}
              onChange={(e) => setLocalEvery(Number(e.target.value))}
            >
              {CHOICES.map((s) => (
                <option key={s} value={s}>
                  {s < 60 ? `${s}s` : `${s / 60}m`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {summary ? (
          <span className="kw-out">
            {summary.checked} checked · {summary.ok} ok · {summary.bad} failing
            {localAt ? ` · ${relative(new Date(localAt).toISOString())}` : ""}
          </span>
        ) : null}
        {fails ? <span className="kw-fails">{fails} consecutive failures</span> : null}
      </div>

      {err ? <div className="kw-msg kw-err">{err}</div> : null}
    </div>
  );
}
