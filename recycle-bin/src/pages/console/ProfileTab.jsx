/* Profile — account details, plan limits and session actions. */

import React, { useEffect, useState } from "react";
import { Alert, Button, Field, TextInput } from "../../components/ui/index.jsx";
import { initials } from "../../lib/auth.js";
import {
  DISCORD_INVITE_URL,
  beginDiscordConnect,
  disconnectDiscord,
  discordAvatarUrl,
  myDiscordIdentity,
  myDiscordJoinGrant,
  takeDiscordResult,
} from "../../lib/discord.js";
import { getSettings } from "../../lib/db.js";
import { compact, money, num, dateTime } from "../../lib/format.js";
import { Stat, StatusChip, TabHead } from "./parts.jsx";

export default function ProfileTab({
  profile,
  user,
  keys = [],
  summary,
  isAdmin = false,
  onSave,
  onResetPassword,
  onSignOut,
}) {
  const email = profile?.email || user?.email || "";
  const [fullName, setFullName] = useState(profile?.full_name || "");
  const [org, setOrg] = useState(profile?.org || "");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    setFullName(profile?.full_name || "");
    setOrg(profile?.org || "");
  }, [profile?.full_name, profile?.org]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      await onSave({ fullName, org });
      setNote({ tone: "ok", text: "Profile updated." });
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not save." });
    } finally {
      setSaving(false);
    }
  };

  const sendReset = async () => {
    setNote(null);
    try {
      await onResetPassword();
      setNote({ tone: "ok", text: `Password reset link sent to ${email}.` });
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not send the link." });
    }
  };

  /* ------------------------------------------------------------- discord */
  const [discord, setDiscord] = useState(null); // the linked identity row
  const [discordOff, setDiscordOff] = useState(false); // v12.6 not installed
  const [discordBusy, setDiscordBusy] = useState(false);
  const [discordNote, setDiscordNote] = useState(null);
  const [joinCredit, setJoinCredit] = useState(0); // the v12.7 offer, USD
  const [joinGrant, setJoinGrant] = useState(null); // …and whether it paid out
  const [discordRequired, setDiscordRequired] = useState(false); // v12.9 gate is on
  const [discordLoaded, setDiscordLoaded] = useState(false); // identity fetch settled

  /* A connect round trip finishes at boot and lands here; its outcome was
     stashed by lib/discord.js. Read it once, on mount (an effect, not a state
     initializer — StrictMode double-invokes initializers and the second read
     would come back empty). */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result && result.mode === "connect") {
      const credit =
        result.creditGranted > 0
          ? ` ${money(result.creditGranted)} landed on your balance.`
          : "";
      setDiscordNote(
        result.ok
          ? {
              tone: "ok",
              text: result.guildJoined
                ? `Discord connected${result.username ? ` as ${result.username}` : ""} — you are in the community server.${credit}`
                : `Discord connected${result.username ? ` as ${result.username}` : ""}. The server join did not go through — use Retry below.`,
            }
          : {
              tone: "error",
              text: result.message || "Discord connect did not finish.",
            },
      );
    }
  }, []);

  useEffect(() => {
    let alive = true;
    myDiscordIdentity()
      .then(({ identity, unavailable }) => {
        if (!alive) return;
        setDiscord(identity);
        setDiscordOff(unavailable);
        setDiscordLoaded(true);
      })
      .catch(() => {
        if (alive) setDiscordLoaded(true);
      });
    /* the v12.7 offer, the v12.9 gate flag, and whether this account already
       collected the join credit */
    getSettings()
      .then((s) => {
        if (!alive) return;
        setJoinCredit(Number(s?.discord_join_credit_usd || 0) || 0);
        setDiscordRequired(s?.discord_required === true);
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

  const connectDiscord = async () => {
    setDiscordBusy(true);
    setDiscordNote(null);
    try {
      /* full-page redirect — the handshake completes at boot on the way back
         and doubles as the guild-join retry when already connected */
      await beginDiscordConnect();
    } catch (err) {
      setDiscordNote({
        tone: "error",
        text: err.message || "Could not start Discord connect.",
      });
      setDiscordBusy(false);
    }
  };

  const removeDiscord = async () => {
    if (
      !window.confirm(
        "Disconnect your Discord account? You can reconnect it at any time.",
      )
    ) {
      return;
    }
    setDiscordBusy(true);
    setDiscordNote(null);
    try {
      await disconnectDiscord();
      setDiscord(null);
      setDiscordNote({ tone: "ok", text: "Discord disconnected." });
    } catch (err) {
      setDiscordNote({
        tone: "error",
        text: err.message || "Could not disconnect.",
      });
    } finally {
      setDiscordBusy(false);
    }
  };

  return (
    <>
      <TabHead title="Profile">
        Your account, plan limits and session. Changing your name here updates it
        everywhere in the console.
      </TabHead>

      <div className="con-profile-hero adm-card">
        <span className="con-avatar">{initials(profile?.full_name || email)}</span>
        <div className="con-profile-id">
          <b>{profile?.full_name || email.split("@")[0] || "Account"}</b>
          <span className="muted small">{email}</span>
          <div className="con-profile-chips">
            <StatusChip value={profile?.status || "active"} />
            <span className="st st-unknown">{profile?.plan || "free"} plan</span>
            {isAdmin ? <span className="st st-working">admin</span> : null}
          </div>
        </div>
        <div className="con-profile-actions">
          <Button size="sm" variant="ghost" onClick={sendReset}>
            Send password reset
          </Button>
          <Button size="sm" variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>

      {note ? (
        <div className="mt-4">
          <Alert tone={note.tone} title={note.tone === "ok" ? "Done" : "Problem"}>
            {note.text}
          </Alert>
        </div>
      ) : null}

      <div className="adm-stats mt-4">
        <Stat
          label="Monthly budget"
          value={
            profile?.monthly_budget_usd == null
              ? "No cap"
              : money(profile.monthly_budget_usd)
          }
          sub="account-wide limit"
        />
        <Stat
          label="Rate limit"
          value={profile?.rate_limit_rpm ? `${num(profile.rate_limit_rpm)}/min` : "—"}
          sub="requests per minute"
        />
        <Stat label="Keys issued" value={num(keys.length)} sub={`${keys.filter((k) => k.status === "active").length} active`} />
        <Stat
          label="Spend (30d)"
          value={money(summary?.cost_usd || 0)}
          sub={`${compact(summary?.requests || 0)} requests`}
        />
      </div>

      <div className="con-split mt-5">
        <div className="adm-card">
          <h3>Account details</h3>
          <p className="sub">Email is managed by your sign-in provider.</p>
          <form onSubmit={submit}>
            <div className="adm-grid two">
              <Field label="Full name" htmlFor="pf-name">
                <TextInput
                  id="pf-name"
                  placeholder="Ada Lovelace"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </Field>
              <Field label="Organisation" htmlFor="pf-org" optional>
                <TextInput
                  id="pf-org"
                  placeholder="Acme Inc"
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Email" htmlFor="pf-email" hint="Read only">
              <TextInput id="pf-email" value={email} readOnly disabled />
            </Field>
            <div className="adm-form-actions">
              <Button type="submit" size="sm" variant="primary" loading={saving}>
                Save changes
              </Button>
            </div>
          </form>
        </div>

        <div className="adm-card">
          <h3>Account metadata</h3>
          <p className="sub">Read-only values from your profile row.</p>
          <ul className="con-meta">
            <li>
              <span>Role</span>
              <b>{profile?.role || "user"}</b>
            </li>
            <li>
              <span>Status</span>
              <b>{profile?.status || "active"}</b>
            </li>
            <li>
              <span>Member since</span>
              <b>{profile?.created_at ? dateTime(profile.created_at) : "—"}</b>
            </li>
            <li>
              <span>User id</span>
              <b className="mono xs">{profile?.id || user?.id || "—"}</b>
            </li>
          </ul>
          {isAdmin ? (
            <div className="adm-form-actions">
              <Button as="a" href="#/admin" size="sm" variant="ghost">
                Open admin panel
              </Button>
            </div>
          ) : null}
        </div>

        <div className="adm-card">
          <h3>Discord</h3>
          <p className="sub">
            Link your Discord account to sign in with it and join the community
            server.
            {joinCredit > 0
              ? ` Join the server and ${money(joinCredit)} lands on your balance — once per account.`
              : ""}
          </p>

          {/* v12.9: when the workspace gates the API on Discord, say so here —
              next to the buttons that fix it — instead of letting keys fail
              with a bare 403. */}
          {discordRequired && discordLoaded && !discordOff && (!discord || !discord.guild_member) ? (
            <div className="mb-4">
              <Alert tone="error" title="API access is paused">
                {!discord
                  ? "This workspace only serves API calls to accounts with a linked Discord that is in the community server. Connect below — your keys stay paused until both are done."
                  : "Your Discord is linked but you are not in the community server, so your keys are paused. Join it below, then use Retry server join."}
              </Alert>
            </div>
          ) : null}

          {discordOff ? (
            <Alert tone="info" title="Not installed">
              Run supabase/upgrade-v12.6-discord.sql in the SQL editor, then
              reload this page.
            </Alert>
          ) : discord ? (
            <>
              <ul className="con-meta">
                <li>
                  <span>Account</span>
                  <b>
                    {discord.avatar ? (
                      <img
                        src={discordAvatarUrl(discord.discord_id, discord.avatar)}
                        alt=""
                        width={18}
                        height={18}
                        style={{
                          borderRadius: "50%",
                          verticalAlign: "-4px",
                          marginRight: 6,
                        }}
                      />
                    ) : null}
                    {discord.global_name || discord.username || "Connected"}
                  </b>
                </li>
                <li>
                  <span>Username</span>
                  <b className="mono xs">{discord.username || "—"}</b>
                </li>
                <li>
                  <span>Community server</span>
                  <b>{discord.guild_member ? "Joined" : "Not joined"}</b>
                </li>
                {joinGrant ? (
                  <li>
                    <span>Join credit</span>
                    <b>{money(Number(joinGrant.amount_usd || 0))} collected</b>
                  </li>
                ) : null}
              </ul>
              {!discord.guild_member && joinCredit > 0 && !joinGrant ? (
                <p className="sub">
                  The {money(joinCredit)} join credit lands when the server join
                  succeeds.
                </p>
              ) : null}
              <div className="adm-form-actions">
                {!discord.guild_member ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={discordBusy}
                    onClick={connectDiscord}
                  >
                    Retry server join
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  loading={discordBusy}
                  onClick={removeDiscord}
                >
                  Disconnect
                </Button>
              </div>
            </>
          ) : (
            <div className="adm-form-actions">
              <Button
                size="sm"
                variant="primary"
                loading={discordBusy}
                onClick={connectDiscord}
              >
                Connect Discord
              </Button>
              {DISCORD_INVITE_URL ? (
                <Button
                  as="a"
                  href={DISCORD_INVITE_URL}
                  target="_blank"
                  rel="noreferrer"
                  size="sm"
                  variant="ghost"
                >
                  Join the server
                </Button>
              ) : null}
            </div>
          )}

          {discordNote ? (
            <div className="mt-4">
              <Alert
                tone={discordNote.tone}
                title={discordNote.tone === "ok" ? "Discord" : "Problem"}
              >
                {discordNote.text}
              </Alert>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
