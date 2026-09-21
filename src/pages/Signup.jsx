import React, { useEffect, useRef, useState } from "react";
import AuthShell, { AuthSuccess } from "../components/auth/AuthShell.jsx";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Field,
  OAuthButton,
  PasswordInput,
  PasswordStrength,
  TextInput,
} from "../components/ui/index.jsx";
import {
  ArrowRightIcon,
  BoltIcon,
  KeyIcon,
  LockIcon,
  MailIcon,
  ShieldIcon,
  UserIcon,
} from "../components/ui/icons.jsx";
import {
  isPersonalEmail,
  pendingReferral,
  rememberReferral,
  signInWithProvider,
  signUp,
  validateEmail,
  validatePassword,
  validateRequired,
} from "../lib/auth.js";
import { beginDiscordSignIn, takeDiscordResult } from "../lib/discord.js";
import { getSettings } from "../lib/db.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";

const FEATS = [
  {
    icon: <KeyIcon />,
    title: "Your own keys",
    body: "budget, rotate, revoke",
  },
  {
    icon: <ShieldIcon />,
    title: "Upstream stays hidden",
    body: "callers see your endpoint, not theirs",
  },
  {
    icon: <BoltIcon />,
    title: "Every call logged",
    body: "latency, tokens, cost",
  },
];

export default function Signup() {
  const [fullName, setFullName] = useState("");
  const [org, setOrg] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [done, setDone] = useState(null); // "session" | "confirm"
  const [signupOpen, setSignupOpen] = useState(true);
  /* ?ref=CODE from an invite link, kept for the whole visit */
  const [referral, setReferral] = useState("");

  const nameRef = useRef(null);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  /* Read the invite code once, then keep it even if the hash changes or the
     visitor detours through Google and comes back. */
  useEffect(() => {
    setReferral(pendingReferral());
    const onHash = () => {
      const code = pendingReferral();
      if (code) setReferral(code);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    getSettings()
      .then((s) => {
        if (s && s.signup_enabled === false) setSignupOpen(false);
      })
      .catch(() => {});
  }, []);

  /* Surface the outcome of a Discord round trip that finished at boot. */
  useEffect(() => {
    const result = takeDiscordResult();
    if (result && !result.ok && result.message) setFormError(result.message);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setFormError("");

    const next = {
      fullName: validateRequired(fullName, "Your name"),
      email: validateEmail(email),
      password: validatePassword(password),
      accepted: accepted ? "" : "Please accept the terms to continue",
    };
    setErrors(next);

    if (next.fullName) return nameRef.current?.focus();
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();
    if (next.accepted) return;
    if (!isConfigured) return setFormError(CONFIG_MESSAGE);

    setBusy(true);
    try {
      const res = await signUp({ email, password, fullName, org, referral });
      setDone(res.needsConfirmation ? "confirm" : "session");
    } catch (err) {
      setFormError(err.message || "Could not create your account.");
    } finally {
      setBusy(false);
    }
  };

  /* Google accounts arrive already verified, so there is no confirmation step:
     the bridge creates the auth user on first sign-in and the existing
     handle_new_user() trigger fills in the profile row exactly as before. */
  const google = async () => {
    setFormError("");
    setOauthBusy(true);
    try {
      await signInWithProvider("google");
      setDone("session");
    } catch (err) {
      setFormError(err.message || "Could not sign up with Google.");
    } finally {
      setOauthBusy(false);
    }
  };

  /* Full-page redirect, not a popup: the handshake completes at boot on the
     way back (lib/discord.js), so only a failure to leave lands in catch. */
  const discord = async () => {
    setFormError("");
    setOauthBusy(true);
    try {
      await beginDiscordSignIn();
    } catch (err) {
      setFormError(err.message || "Could not sign up with Discord.");
      setOauthBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="create account"
      headline="Put your own API in front."
      sub="Mint a key. Route through endpoints you control."
      feats={FEATS}
    >
      {done === "session" ? (
        <AuthSuccess
          title="Account created"
          sub="You are signed in and ready to mint your first key."
          lines={[
            { text: "firebase account created → ok" },
            { text: "profile row created" },
            { text: "loading dashboard…", tone: "ok" },
          ]}
        />
      ) : done === "confirm" ? (
        <AuthSuccess
          title="Confirm your email"
          sub={`We sent a verification link to ${email}. Click it to activate your account.`}
          lines={[
            { text: "firebase account created → ok" },
            { text: "verification email sent", tone: "ok" },
          ]}
          redirectTo={null}
        />
      ) : (
        <>
          <div className="auth-card-head">
            <h1>Create your account</h1>
            <p>
              Already registered? <a href="#/login">Sign in</a>
            </p>
          </div>

          {referral ? (
            <p className="small muted">
              Invite code <b className="mono">{referral}</b> applied — credit lands on both
              accounts.{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  rememberReferral("");
                  setReferral("");
                }}
              >
                Remove
              </button>
            </p>
          ) : null}

          {!isConfigured ? (
            <Alert tone="error" title="Setup needed">
              {CONFIG_MESSAGE}
            </Alert>
          ) : null}

          {signupOpen ? (
            <>
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
            </>
          ) : null}

          {!signupOpen ? (
            <Alert tone="info" title="Sign-ups are closed">
              An admin has disabled new registrations for this workspace.
            </Alert>
          ) : null}

          <form className="auth-form" onSubmit={submit} noValidate>
            {formError ? (
              <Alert tone="error" title="Could not create account">
                {formError}
              </Alert>
            ) : null}

            <Field label="Full name" htmlFor="name" error={errors.fullName} describedBy="name-msg">
              <TextInput
                id="name"
                ref={nameRef}
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={fullName}
                invalid={Boolean(errors.fullName)}
                icon={<UserIcon width={15} height={15} />}
                onChange={(e) => setFullName(e.target.value)}
              />
            </Field>

            <Field label="Organisation" htmlFor="org" optional hint="Shown in the console header">
              <TextInput
                id="org"
                autoComplete="organization"
                placeholder="Acme Inc."
                value={org}
                onChange={(e) => setOrg(e.target.value)}
              />
            </Field>

            <Field
              label="Gmail address"
              htmlFor="signup-email"
              error={errors.email}
              hint={
                email && isPersonalEmail(email)
                  ? "Personal address detected — that works fine too."
                  : undefined
              }
              describedBy="signup-email-msg"
            >
              <TextInput
                id="signup-email"
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

            <Field
              label="Password"
              htmlFor="signup-password"
              error={errors.password}
              describedBy="signup-password-msg"
            >
              <PasswordInput
                id="signup-password"
                ref={passwordRef}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                invalid={Boolean(errors.password)}
                icon={<LockIcon width={15} height={15} />}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <PasswordStrength value={password} />

            <Checkbox id="terms" checked={accepted} onChange={setAccepted} invalid={Boolean(errors.accepted)}>
              I agree to the acceptable use and privacy terms of this workspace.
            </Checkbox>
            {errors.accepted ? (
              <p className="sui-err" role="alert">
                {errors.accepted}
              </p>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              block
              loading={busy}
              disabled={!signupOpen}
              iconRight={<ArrowRightIcon />}
            >
              Create account
            </Button>

            <Divider>what happens next</Divider>
            <p className="auth-fineprint">
              If email confirmation is on, you will get a verification link before the
              console unlocks.
            </p>
          </form>
        </>
      )}
    </AuthShell>
  );
}
