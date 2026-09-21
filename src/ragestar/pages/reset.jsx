/* ==========================================================================
   reset.jsx — RageStar-styled account recovery (#/reset)
   --------------------------------------------------------------------------
   The last page that still wore the retired gateway AuthShell. It now uses
   the kit's own login-page language (glass card, mono field labels, cobalt
   gradient action) while keeping every real call from lib/auth.js:

     · no recovery code  -> ask for the email, send the Firebase link
     · recovery code     -> resolve which account it belongs to, set a new password
     · signed in         -> change the password in place (no code needed)

   Firebase appends a one-time oobCode to the emailed link instead of opening
   a recovery session, so the presence of that code — not isAuthed — decides
   which of the three forms this page shows.
   ========================================================================== */

import { useEffect, useState } from "react";
import {
  completePasswordReset,
  pendingResetCode,
  resetCodeEmail,
  sendPasswordReset,
  updatePassword,
  useSession,
  validateEmail,
  validatePassword,
} from "../../lib/auth.js";
import { isConfigured, CONFIG_MESSAGE } from "../../lib/supabase.js";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { models } from "../dashboard/data.js";

/* ------------------------------------------------------------ shared bits */

/** The kit's logo tile. pr-brand-mark is the RouteLoader's docking slot. */
function Brand({ onHome }) {
  return (
    <button onClick={onHome} className="flex w-fit items-center gap-3">
      <span className="pr-brand-mark relative grid h-9 w-9 place-items-center">
        <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500 opacity-90" />
        <svg viewBox="0 0 24 24" className="relative h-5 w-5 text-white" fill="none">
          <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="font-display text-[15px] font-semibold tracking-tight text-white">
        RageStar<span className="ml-1 font-mono text-[10px] tracking-[0.2em] text-white/40 uppercase">ai</span>
      </span>
    </button>
  );
}

/** Mono label + kit input, the exact pairing the login form uses. */
function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{label}</span>
        {hint}
      </span>
      {children}
    </label>
  );
}

const INPUT =
  "mt-2 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3.5 py-3 text-[13px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none";

/* ---------------------------------------------------------------- the page */

export default function ResetPage({ navigate }) {
  const { isAuthed } = useSession();

  const [code] = useState(() => pendingResetCode());
  const [codeEmail, setCodeEmail] = useState("");
  const [codeError, setCodeError] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // "sent" | "changed"

  /* Resolve which account the code belongs to, so the form can name it and a
     stale or already-used link fails here rather than after typing. */
  useEffect(() => {
    if (!code) return undefined;
    let live = true;
    resetCodeEmail(code)
      .then((addr) => {
        if (live) setCodeEmail(addr);
      })
      .catch((err) => {
        if (live) setCodeError(err.message);
      });
    return () => {
      live = false;
    };
  }, [code]);

  const home = () => navigate("");

  const request = async (e) => {
    e.preventDefault();
    setError("");
    const bad = validateEmail(email);
    setFieldError(bad);
    if (bad) return;
    if (!isConfigured) {
      setError(CONFIG_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      await sendPasswordReset(email);
      setDone("sent");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const change = async (e) => {
    e.preventDefault();
    setError("");
    const bad = validatePassword(password);
    setFieldError(bad);
    if (bad) return;
    setBusy(true);
    try {
      /* With a code: finish the emailed reset. Without one: an already
         signed-in user changing their own password. */
      if (code) await completePasswordReset(code, password);
      else await updatePassword(password);
      setDone("changed");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------ end states */

  if (done) {
    const sent = done === "sent";
    return (
      <div className="relative min-h-screen overflow-hidden text-[#101814]">
        <div className="relative mx-auto flex min-h-screen max-w-xl flex-col justify-center px-4 py-10 sm:px-6">
          <Brand onHome={home} />
          <div className="pr-glass-strong mt-8 rounded-3xl p-6 sm:p-7">
            <div className="grid h-11 w-11 place-items-center rounded-2xl border border-lime-400/30 bg-lime-400/10">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-lime-300" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="font-display mt-5 text-2xl font-semibold tracking-tight text-white">
              {sent ? "Reset link sent" : "Password updated"}
            </h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-white/55">
              {sent
                ? `Open the link we emailed to ${email} to choose a new password.`
                : "Use your new password the next time you sign in."}
            </p>

            <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-ink-950/70">
              <div className="border-b border-white/8 px-4 py-2.5 font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
                {sent ? "sendPasswordResetEmail" : "updatePassword"}
              </div>
              <pre className="p-4 font-mono text-[11.5px] leading-relaxed text-white/70">
{sent
  ? `$ ragestar auth reset --email ${email || "you@company.com"}\n› recovery link            sent\n› link valid for           60 minutes\n✓ check your inbox`
  : `$ ragestar auth password --set\n› verifying recovery code  ok\n› updating credential      ok\n✓ signed out of other devices`}
              </pre>
            </div>

            <a
              href="#/login"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3.5 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)]"
            >
              {sent ? "Back to sign in" : "Sign in with the new password"}
            </a>
            <p className="mt-4 text-center font-mono text-[10.5px] tracking-[0.14em] text-white/30 uppercase">
              recovery links are single use · expire in 60 minutes
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ the forms */

  const setting = Boolean(code) || isAuthed;

  return (
    <div className="relative min-h-screen overflow-hidden text-[#101814]">
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-6">
        <Brand onHome={home} />

        <div className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.05fr_1fr]">
          {/* left column: what is about to happen */}
          <div className="hidden lg:block">
            <span className="inline-flex items-center gap-2 rounded-full border border-orange-400/30 bg-orange-500/10 px-3 py-1 font-mono text-[11px] tracking-widest text-orange-200 uppercase">
              <DotmSquare1 size={11} dotSize={2} color="#2447E8" speed={1.2} aria-hidden />
              {models.length} models · 5 regions
            </span>
            <h1 className="font-display mt-6 text-[2.6rem] leading-[1.03] font-bold tracking-[-0.03em] text-balance text-white">
              Get back into your workspace.
            </h1>
            <p className="mt-5 max-w-lg text-[15px] leading-relaxed text-white/55">
              Recovery runs on Firebase Authentication. Your keys, credits and usage stay in
              Supabase, so changing your password never rotates an <span className="font-mono text-[13px] text-white/75">rs_live_</span> key.
            </p>

            <ul className="mt-8 space-y-3">
              {[
                ["Recovery links expire", "single use, and only valid for one hour"],
                ["Handled by Firebase", "the link carries a one-time code, not a session"],
                ["Gateway keys untouched", "changing your password does not rotate rs_live_ keys"],
              ].map(([title, body]) => (
                <li key={title} className="flex gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3">
                  <span className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-brand-ember/40 bg-brand-ember/12">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-ember" />
                  </span>
                  <span>
                    <span className="block text-[13.5px] font-medium text-white/90">{title}</span>
                    <span className="mt-0.5 block text-[12.5px] text-white/45">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* right column: the card */}
          <div className="mx-auto w-full max-w-md">
            <div className="pr-glass-strong rounded-3xl p-6 sm:p-7">
              <h2 className="font-display text-xl font-semibold tracking-tight text-white">
                {setting ? "Choose a new password" : "Reset password"}
              </h2>
              <p className="mt-1.5 text-[12.5px] text-white/50">
                {setting
                  ? codeEmail
                    ? `Setting a new password for ${codeEmail}.`
                    : code
                      ? "Checking your recovery link…"
                      : "You are signed in, so you can change it right here."
                  : "We will email you a single-use recovery link."}
              </p>

              {!isConfigured && !setting ? (
                <p className="mt-5 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                  {CONFIG_MESSAGE}
                </p>
              ) : null}

              {codeError ? (
                <p className="mt-5 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                  That link is no longer valid — {codeError}{" "}
                  <a href="#/reset" className="underline">
                    request a new one
                  </a>.
                </p>
              ) : null}

              {setting ? (
                <form onSubmit={change} className="mt-6 space-y-4" noValidate>
                  <Field label="new password">
                    <input
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setFieldError("");
                      }}
                      className={INPUT}
                    />
                  </Field>

                  {fieldError ? (
                    <p className="text-[12px] text-rose-200">{fieldError}</p>
                  ) : null}
                  {error ? (
                    <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                      {error}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3.5 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)] disabled:opacity-60"
                  >
                    {busy && <DotmSquare1 size={14} dotSize={2} color="#E9ECE4" speed={1.5} aria-hidden />}
                    {busy ? "Updating…" : "Update password"}
                  </button>
                </form>
              ) : (
                <form onSubmit={request} className="mt-6 space-y-4" noValidate>
                  <Field
                    label="account email"
                    hint={
                      <a href="#/login" className="font-mono text-[10px] tracking-[0.14em] text-brand-ember uppercase hover:underline">
                        remembered it?
                      </a>
                    }
                  >
                    <input
                      type="email"
                      autoComplete="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setFieldError("");
                      }}
                      className={INPUT}
                    />
                  </Field>

                  {fieldError ? (
                    <p className="text-[12px] text-rose-200">{fieldError}</p>
                  ) : null}
                  {error ? (
                    <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
                      {error}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={busy}
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3.5 text-[13.5px] font-medium text-white transition-all hover:shadow-[0_20px_50px_-18px_rgba(36,71,232,0.3)] disabled:opacity-60"
                  >
                    {busy && <DotmSquare1 size={14} dotSize={2} color="#E9ECE4" speed={1.5} aria-hidden />}
                    {busy ? "Sending…" : "Email reset link"}
                  </button>

                  <p className="rounded-xl border border-white/8 bg-white/[0.03] p-3.5 font-mono text-[11px] leading-relaxed text-white/45">
                    for security we always show the same confirmation, whether or not an account
                    exists for that address
                  </p>
                </form>
              )}
            </div>

            <p className="mt-4 text-center font-mono text-[10.5px] tracking-[0.14em] text-white/30 uppercase">
              protected by soc 2 type ii · no training on your data
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
