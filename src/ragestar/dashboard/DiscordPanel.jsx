/* ==========================================================================
   DiscordPanel — the community link, on the screen where it can be fixed
   --------------------------------------------------------------------------
   The v12.9 gate refuses every API call from an account whose Discord is not
   linked and in the community server. Its refusal text says where to go and
   fix it — but until now the only card that could actually do the linking
   lived on the console's Profile tab, and v12.8 retired #/console. That tab is
   only reachable from src/pages/Console.jsx / Workspace.jsx, neither of which
   is imported by anything any more, so an account that tripped the gate had
   nowhere to comply. This is that card, rebuilt in the kit's paper theme and
   mounted on the live settings screen.

   Everything here goes through src/lib/discord.js: the OAuth handshake is a
   full-page redirect that finishes at boot and is collected by
   takeDiscordResult(), and membership is read from public.discord_identities,
   which only the discord-auth function can write — the browser cannot forge
   it.
   ========================================================================== */

import { useEffect, useState } from "react";
import { cn } from "../lib/cn.js";
import { getSettings } from "../../lib/db.js";
import { money } from "../../lib/format.js";
import {
  DISCORD_INVITE_URL,
  beginDiscordConnect,
  disconnectDiscord,
  discordAvatarUrl,
  myDiscordIdentity,
  myDiscordJoinGrant,
  takeDiscordResult,
} from "../../lib/discord.js";

/** One row of the read-only detail list. */
function Row({ k, children }) {
  return (
    <li className="flex items-center justify-between gap-4 border-b border-white/8 py-3 last:border-b-0">
      <span className="font-mono text-[10.5px] tracking-[0.14em] text-white/45 uppercase">{k}</span>
      <span className="min-w-0 truncate text-[12.5px] text-white/85">{children}</span>
    </li>
  );
}

export function DiscordPanel({ Panel }) {
  /* The linked identity row, or null. `unavailable` means the v12.6 migration
     has not been run, which is a different problem from "not connected". */
  const [identity, setIdentity] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [gateOn, setGateOn] = useState(false);
  const [joinCredit, setJoinCredit] = useState(0);
  const [joinGrant, setJoinGrant] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  /* A connect round trip lands back here with its outcome stashed by
     lib/discord.js. Read it once on mount. */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result && result.mode === "connect") {
      const credit =
        result.creditGranted > 0 ? ` ${money(result.creditGranted)} landed on your balance.` : "";
      const who = result.username ? ` as ${result.username}` : "";
      setNote(
        result.ok
          ? {
              tone: "ok",
              text: result.guildJoined
                ? `Discord connected${who} — you are in the community server.${credit}`
                : `Discord connected${who}. The server join did not go through — use Retry server join below.`,
            }
          : { tone: "error", text: result.message || "Discord connect did not finish." },
      );
    }
  }, []);

  useEffect(() => {
    let alive = true;
    myDiscordIdentity()
      .then(({ identity: row, unavailable: off }) => {
        if (!alive) return;
        setIdentity(row);
        setUnavailable(off);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    getSettings()
      .then((s) => {
        if (!alive) return;
        setJoinCredit(Number(s?.discord_join_credit_usd || 0) || 0);
        setGateOn(s?.discord_required === true);
      })
      .catch(() => {});
    myDiscordJoinGrant()
      .then((g) => {
        if (alive) setJoinGrant(g);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    setNote(null);
    try {
      /* Full-page redirect; the handshake completes at boot on the way back.
         When already linked this doubles as the guild-join retry. */
      await beginDiscordConnect();
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not start Discord connect." });
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Disconnect your Discord account? You can reconnect it at any time.")) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await disconnectDiscord();
      setIdentity(null);
      setNote({ tone: "ok", text: "Discord disconnected." });
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not disconnect." });
    } finally {
      setBusy(false);
    }
  };

  /* Blocked only when the gate is on, the answer is known, and something is
     still missing. While the identity fetch is in flight we say nothing rather
     than flashing a false alarm. */
  const blocked = gateOn && loaded && !unavailable && (!identity || !identity.guild_member);

  return (
    <Panel
      title="Discord"
      subtitle="link it to sign in with it and to join the community server"
      action={
        blocked ? (
          <span className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-rose-200 uppercase">
            required
          </span>
        ) : null
      }
    >
      <p className="text-[12.5px] leading-relaxed text-white/55">
        {gateOn
          ? "This workspace only serves API calls to accounts with a linked Discord that is in the community server. Your keys stay paused until both are done."
          : "Link your Discord account to sign in with it and to join the community server."}
        {joinCredit > 0 && !joinGrant
          ? ` Join the server and ${money(joinCredit)} lands on your balance — once per account.`
          : ""}
      </p>

      {blocked ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-[12.5px] text-rose-100"
        >
          {!identity
            ? "API access is paused — connect a Discord account below."
            : "API access is paused — your Discord is linked but you are not in the community server. Join it below, then use Retry server join."}
        </p>
      ) : null}

      {unavailable ? (
        <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-100">
          Not installed — run supabase/upgrade-v12.6-discord.sql in the SQL editor, then reload.
        </p>
      ) : identity ? (
        <>
          <ul className="mt-3">
            <Row k="account">
              <span className="inline-flex items-center gap-2">
                {identity.avatar ? (
                  <img
                    src={discordAvatarUrl(identity.discord_id, identity.avatar)}
                    alt=""
                    width={18}
                    height={18}
                    className="rounded-full"
                  />
                ) : null}
                {identity.global_name || identity.username || "Connected"}
              </span>
            </Row>
            <Row k="username">{identity.username || "—"}</Row>
            <Row k="community server">
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 font-mono text-[9.5px] tracking-[0.12em] uppercase",
                  identity.guild_member
                    ? "border-lime-400/30 bg-lime-500/10 text-lime-200"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-100",
                )}
              >
                {identity.guild_member ? "Joined" : "Not joined"}
              </span>
            </Row>
            {joinGrant ? <Row k="join credit">{money(Number(joinGrant.amount_usd || 0))} collected</Row> : null}
          </ul>

          {!identity.guild_member && joinCredit > 0 && !joinGrant ? (
            <p className="mt-2 text-[11.5px] text-white/50">
              The {money(joinCredit)} join credit lands when the server join succeeds.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-[12.5px] text-white/55">No Discord account is linked yet.</p>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {identity ? (
          <>
            {!identity.guild_member ? (
              <button
                onClick={connect}
                disabled={busy}
                className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2.5 text-[12.5px] text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
              >
                {busy ? "Working…" : "Retry server join"}
              </button>
            ) : null}
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2.5 text-[12.5px] text-white/85 transition-colors hover:bg-white/10 disabled:opacity-60"
            >
              Disconnect
            </button>
          </>
        ) : (
          <>
            <button
              onClick={connect}
              disabled={busy}
              className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-2.5 text-[12.5px] font-medium text-white disabled:opacity-60"
            >
              {busy ? "Redirecting…" : "Connect Discord"}
            </button>
            {DISCORD_INVITE_URL ? (
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2.5 text-[12.5px] text-white/85 transition-colors hover:bg-white/10"
              >
                Join the server
              </a>
            ) : null}
          </>
        )}
      </div>

      {note ? (
        <p
          role="alert"
          className={cn(
            "mt-4 rounded-xl border px-3.5 py-2.5 text-[12.5px]",
            note.tone === "ok"
              ? "border-lime-400/25 bg-lime-500/10 text-lime-100"
              : "border-rose-400/30 bg-rose-500/10 text-rose-100",
          )}
        >
          {note.text}
        </p>
      ) : null}
    </Panel>
  );
}
