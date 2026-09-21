import React, { useEffect, useRef, useState } from "react";
import AuthShell, { AuthSuccess } from "../components/auth/AuthShell.jsx";
import { Alert, Button, Divider, Field, PasswordInput, PasswordStrength, TextInput } from "../components/ui/index.jsx";
import { ArrowRightIcon, KeyIcon, LockIcon, MailIcon, ShieldIcon } from "../components/ui/icons.jsx";
import {
  completePasswordReset,
  pendingResetCode,
  resetCodeEmail,
  sendPasswordReset,
  updatePassword,
  useSession,
  validateEmail,
  validatePassword,
} from "../lib/auth.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";

const FEATS = [
  { icon: <ShieldIcon />, title: "Recovery links expire", body: "single use, and only valid for one hour" },
  { icon: <LockIcon />, title: "Handled by Firebase", body: "the link carries a one-time code, not a session" },
  { icon: <KeyIcon />, title: "Gateway keys untouched", body: "changing your password does not rotate rs_live_ keys" },
];

/**
 * Two states in one page:
 *  - no recovery session  -> ask for the email and send the link
 *  - recovery session live -> set the new password
 */
export default function ResetPassword() {
  const { isAuthed } = useSession();
  /* Firebase appends a one-time oobCode to the link instead of creating a
     recovery session, so the presence of that code - not isAuthed - is what
     decides whether this page asks for an email or a new password. */
  const [code] = useState(() => pendingResetCode());
  const [codeEmail, setCodeEmail] = useState("");
  const [codeError, setCodeError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // "sent" | "changed"
  const emailRef = useRef(null);
  const passRef = useRef(null);

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

  const request = async (e) => {
    e.preventDefault();
    setError("");
    const bad = validateEmail(email);
    setFieldError(bad);
    if (bad) return emailRef.current?.focus();
    if (!isConfigured) return setError(CONFIG_MESSAGE);

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
    if (bad) return passRef.current?.focus();

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

  return (
    <AuthShell
      eyebrow="account recovery"
      headline={isAuthed ? "Set a new password." : "Reset your password."}
      sub="Sign-in and recovery run on Firebase Authentication. Your keys, credits and usage stay in Supabase."
      feats={FEATS}
    >
      {done === "sent" ? (
        <AuthSuccess
          title="Reset link sent"
          sub={`Open the link we emailed to ${email} to choose a new password.`}
          lines={[{ text: "sendPasswordResetEmail → sent" }, { text: "link valid for 60 minutes", tone: "ok" }]}
          redirectTo={null}
        />
      ) : done === "changed" ? (
        <AuthSuccess
          title="Password updated"
          sub="Use your new password next time you sign in."
          lines={[{ text: "password updated → ok" }, { text: "sign in to continue", tone: "ok" }]}
        />
      ) : code || isAuthed ? (
        <>
          <div className="auth-card-head">
            <h1>Choose a new password</h1>
            <p>
              {codeEmail
                ? `Setting a new password for ${codeEmail}.`
                : code
                  ? "Checking your recovery link…"
                  : "You are signed in, so you can change it right here."}
            </p>
          </div>
          <form className="auth-form" onSubmit={change} noValidate>
            {codeError ? (
              <Alert tone="error" title="That link is no longer valid">
                {codeError} <a href="#/reset">Request a new link</a>
              </Alert>
            ) : null}
            {error ? <Alert tone="error" title="Could not update password">{error}</Alert> : null}
            <Field label="New password" htmlFor="new-password" error={fieldError} describedBy="new-password-msg">
              <PasswordInput
                id="new-password"
                ref={passRef}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                invalid={Boolean(fieldError)}
                icon={<LockIcon width={15} height={15} />}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <PasswordStrength value={password} />
            <Button type="submit" variant="primary" block loading={busy} iconRight={<ArrowRightIcon />}>
              Update password
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="auth-card-head">
            <h1>Reset password</h1>
            <p>
              Remembered it? <a href="#/login">Back to sign in</a>
            </p>
          </div>
          <form className="auth-form" onSubmit={request} noValidate>
            {!isConfigured ? <Alert tone="error" title="Setup needed">{CONFIG_MESSAGE}</Alert> : null}
            {error ? <Alert tone="error" title="Could not send link">{error}</Alert> : null}
            <Field label="Account email" htmlFor="reset-email" error={fieldError} describedBy="reset-email-msg">
              <TextInput
                id="reset-email"
                ref={emailRef}
                type="email"
                autoComplete="email"
                placeholder="you@gmail.com"
                value={email}
                invalid={Boolean(fieldError)}
                icon={<MailIcon width={15} height={15} />}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" block loading={busy} iconRight={<ArrowRightIcon />}>
              Email reset link
            </Button>
            <Divider>note</Divider>
            <p className="auth-fineprint">
              For security we always show the same confirmation, whether or not an
              account exists for that address.
            </p>
          </form>
        </>
      )}
    </AuthShell>
  );
}
