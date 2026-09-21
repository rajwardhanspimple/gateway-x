import React, { useEffect, useRef, useState } from "react";
import AuthShell, { AuthSuccess } from "../components/auth/AuthShell.jsx";
import {
  Alert,
  Button,
  Divider,
  Field,
  OAuthButton,
  PasswordInput,
  Segmented,
  TextInput,
} from "../components/ui/index.jsx";
import {
  ArrowRightIcon,
  BoltIcon,
  KeyIcon,
  LockIcon,
  MailIcon,
  ShieldIcon,
} from "../components/ui/icons.jsx";
import {
  sendMagicLink,
  sendPasswordReset,
  resendConfirmation,
  signIn,
  signInWithProvider,
  validateEmail,
  validatePassword,
} from "../lib/auth.js";
import { beginDiscordSignIn, takeDiscordResult } from "../lib/discord.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";

const FEATS = [
  {
    icon: <BoltIcon />,
    title: "One endpoint",
    body: "your app talks to your gateway, never to the upstream provider",
  },
  {
    icon: <ShieldIcon />,
    title: "Upstream stays hidden",
    body: "provider host, model id and keys live only in your database",
  },
  {
    icon: <KeyIcon />,
    title: "Keys you control",
    body: "mint, budget and revoke gateway keys from the console",
  },
];

export default function Login() {
  const [mode, setMode] = useState("password"); // password | magic
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // "session" | "magic"
  const [oauthBusy, setOauthBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  /* A Discord round trip ends at boot, before this page mounts: whatever
     happened there was stashed by lib/discord.js. Say it out loud once. */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result && !result.ok && result.message) setFormError(result.message);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setFormError("");
    setNotice("");
    setNeedsConfirm(false);

    const next = { email: validateEmail(email) };
    if (mode === "password") next.password = validatePassword(password) ? "Password is required" : "";
    setErrors(next);

    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();
    if (!isConfigured) return setFormError(CONFIG_MESSAGE);

    setBusy(true);
    try {
      if (mode === "magic") {
        await sendMagicLink(email);
        setDone("magic");
      } else {
        await signIn({ email, password });
        setDone("session");
      }
    } catch (err) {
      const msg = err.message || "Could not sign you in.";
      setFormError(msg);
      if (msg.toLowerCase().includes("confirm your email")) setNeedsConfirm(true);
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    setFormError("");
    setNotice("");
    const bad = validateEmail(email);
    if (bad) {
      setErrors((s) => ({ ...s, email: bad }));
      emailRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await sendPasswordReset(email);
      setNotice(`Password reset link sent to ${email}.`);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    try {
      await resendConfirmation(email);
      setNotice(`Confirmation email resent to ${email}.`);
      setNeedsConfirm(false);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* Google sign-in. In popup mode this resolves right here; in redirect mode
     the page navigates away and lib/auth.js finishes the handshake on the way
     back, so the only thing left to handle here is the error. */
  const google = async () => {
    setFormError("");
    setNotice("");
    setOauthBusy(true);
    try {
      await signInWithProvider("google");
      setDone("session");
    } catch (err) {
      setFormError(err.message || "Could not sign in with Google.");
    } finally {
      setOauthBusy(false);
    }
  };

  /* Discord is a full-page redirect, not a popup: beginDiscordSignIn
     navigates away and lib/discord.js finishes the handshake at boot on the
     way back, so reaching catch means the trip never started. The spinner
     stays up on purpose while the page unloads. */
  const discord = async () => {
    setFormError("");
    setNotice("");
    setOauthBusy(true);
    try {
      await beginDiscordSignIn();
    } catch (err) {
      setFormError(err.message || "Could not sign in with Discord.");
      setOauthBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="welcome back"
      headline="Sign in to your gateway."
      sub="Manage routed models, upstream keys and usage from one console."
      feats={FEATS}
    >
      {done === "session" ? (
        <AuthSuccess
          title="Signed in"
          sub="Verified by Firebase, authorised against your Supabase project."
          lines={[
            { text: "firebase sign-in → ok" },
            { text: "session token stored" },
            { text: "loading dashboard…", tone: "ok" },
          ]}
        />
      ) : done === "magic" ? (
        <AuthSuccess
          title="Check your inbox"
          sub={`We sent a one-time sign-in link to ${email}.`}
          lines={[{ text: "sign-in link sent" }, { text: "link expires in 60 minutes", tone: "ok" }]}
          redirectTo={null}
        />
      ) : (
        <>
          <div className="auth-card-head">
            <h1>Sign in</h1>
            <p>
              No account yet? <a href="#/signup">Create one</a>
            </p>
          </div>

          {!isConfigured ? (
            <Alert tone="error" title="Setup needed">
              {CONFIG_MESSAGE}
            </Alert>
          ) : null}

          <OAuthButton
            provider="google"
            busy={oauthBusy}
            disabled={busy || !isConfigured}
            onClick={google}
          />
          <OAuthButton
            provider="discord"
            busy={oauthBusy}
            disabled={busy || !isConfigured}
            onClick={discord}
          />

          <Divider>or use your email</Divider>

          <Segmented
            ariaLabel="Sign-in method"
            value={mode}
            onChange={setMode}
            options={[
              { value: "password", label: "Password", icon: <LockIcon width={14} height={14} /> },
              { value: "magic", label: "Magic link", icon: <MailIcon width={14} height={14} /> },
            ]}
          />

          <form className="auth-form" onSubmit={submit} noValidate>
            {formError ? (
              <Alert
                tone="error"
                title="Could not sign in"
                action={
                  needsConfirm ? (
                    <Button size="sm" variant="ghost" onClick={resend} loading={busy}>
                      Resend
                    </Button>
                  ) : null
                }
              >
                {formError}
              </Alert>
            ) : null}
            {notice ? <Alert tone="ok" title="Email sent">{notice}</Alert> : null}

            <Field label="Gmail address" htmlFor="email" error={errors.email} describedBy="email-msg">
              <TextInput
                id="email"
                ref={emailRef}
                type="email"
                autoComplete="email"
                placeholder="you@gmail.com"
                value={email}
                invalid={Boolean(errors.email)}
                icon={<MailIcon width={15} height={15} />}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            {mode === "password" ? (
              <Field
                label="Password"
                htmlFor="password"
                error={errors.password}
                describedBy="password-msg"
              >
                <PasswordInput
                  id="password"
                  ref={passwordRef}
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  value={password}
                  invalid={Boolean(errors.password)}
                  icon={<LockIcon width={15} height={15} />}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            ) : (
              <p className="muted small">
                We email you a single-use link. No password needed.
              </p>
            )}

            <div className="auth-row">
              <button type="button" className="auth-link" onClick={forgot} disabled={busy}>
                Forgot password?
              </button>
            </div>

            <Button type="submit" variant="primary" block loading={busy} iconRight={<ArrowRightIcon />}>
              {mode === "magic" ? "Email me a link" : "Sign in"}
            </Button>

            <Divider>secure session</Divider>
            <p className="auth-fineprint">
              Firebase issues and refreshes your sign-in, which is exchanged for a
              short-lived Supabase token so your data stays behind the same
              row-level rules. Gateway keys are never stored in the browser.
            </p>
          </form>
        </>
      )}
    </AuthShell>
  );
}
