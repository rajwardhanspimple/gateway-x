import React, { useEffect, useState } from "react";
import { useSession, refreshProfile, retrySession } from "../lib/auth.js";
import { isConfigured, CONFIG_MESSAGE } from "../lib/supabase.js";
import { Spinner, Alert, Button } from "./ui/index.jsx";

/**
 * Gate for authenticated routes.
 * `admin` = also require profiles.role = 'admin' (and status = 'active', which
 * is what public.is_admin() checks on the database side).
 *
 * The admin gate used to render a flat "This area is restricted to workspace
 * admins." for every possible cause: a genuine non-admin, a suspended account,
 * a missing profiles row, or a profile read that simply failed. Those need very
 * different fixes, so this screen now reports which one it is.
 */
export default function RequireAuth({ admin = false, children }) {
  const {
    loading,
    isAuthed,
    isAdmin,
    roleKnown,
    profile,
    profileMissing,
    profileError,
    user,
    authError,
  } = useSession();
  const [retrying, setRetrying] = useState(false);

  /* v10: re-runs the Firebase -> Supabase handshake. A dropped network or a
     cold bridge function is a retry, not a sign-out. */
  const onRetrySession = async () => {
    setRetrying(true);
    try {
      await retrySession();
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    /* Do not bounce to sign-in when the session check itself failed: that
       would hide the reason and throw away the retry. */
    if (!loading && !isAuthed && isConfigured && !authError) {
      window.location.hash = "#/login";
    }
  }, [loading, isAuthed, authError]);

  if (!isConfigured) {
    return (
      <main id="main" className="container section">
        <Alert tone="error" title="Setup needed">{CONFIG_MESSAGE}</Alert>
      </main>
    );
  }

  if (loading) {
    return (
      <main id="main" className="container section gate-wait">
        <Spinner size={22} />
        <p className="muted small mt-4">Checking your session…</p>
      </main>
    );
  }

  /* Signed in with Firebase but the Supabase side never came back: the bridge
     function is missing, the ID token was refused, or the network dropped. */
  if (authError && !isAuthed) {
    return (
      <main id="main" className="container section gate-wait">
        <Alert tone="error" title="Could not confirm your session">
          {authError.message || "Your sign-in could not be verified."}
        </Alert>
        <p className="muted small mt-4">
          Firebase signs you in, then the <b className="mono">firebase-auth</b> function
          exchanges that for a short-lived Supabase token. Only the second step failed,
          so retrying usually fixes it.
        </p>
        <p className="mt-4" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" size="sm" onClick={onRetrySession} disabled={retrying}>
            {retrying ? "Retrying…" : "Try again"}
          </Button>
          <Button as="a" href="#/login" variant="ghost" size="sm">
            Back to sign in
          </Button>
        </p>
      </main>
    );
  }

  if (!isAuthed) {
    return (
      <main id="main" className="container section gate-wait">
        <Alert tone="info" title="Sign in required">Redirecting to the sign-in page…</Alert>
        <p className="mt-4"><Button as="a" href="#/login" variant="primary" size="sm">Go to sign in</Button></p>
      </main>
    );
  }

  if (admin && !isAdmin) {
    const email = profile?.email || user?.email || "unknown";

    /* Work out which of the four causes this actually is. */
    let title = "Admin access not granted";
    let reason =
      'Your profile row says role "' + (profile?.role || "user") + '", not "admin".';
    let fix =
      "Ask a workspace admin to change your role, or run supabase/upgrade-v7.1-admin-access.sql with your email in it.";

    if (!roleKnown) {
      title = "Could not confirm your role";
      reason = profileError
        ? "Reading your profile row failed, so your role is unknown."
        : "You have a session, but no matching row in the profiles table.";
      fix = profileError
        ? "This is usually a row-level-security policy or a missing column rather than a permissions decision. Retry, then check the details below."
        : "The signup trigger did not create your profile row. Run supabase/upgrade-v7.1-admin-access.sql, or scripts/recover-admin.mjs with the service-role key.";
    } else if (profile?.status && profile.status !== "active") {
      title = "Account is not active";
      reason =
        'Your role is "' +
        profile.role +
        '" but your status is "' +
        profile.status +
        '".';
      fix =
        "is_admin() requires role = 'admin' AND status = 'active'. A suspended admin fails every admin policy. upgrade-v7.1-admin-access.sql sets the status back to active.";
    }

    const onRetry = async () => {
      setRetrying(true);
      try {
        await refreshProfile();
      } finally {
        setRetrying(false);
      }
    };

    return (
      <main id="main" className="container section gate-wait">
        <Alert tone="error" title={title}>
          {reason}
        </Alert>

        <ul className="muted small mt-4">
          <li>Signed in as <b>{email}</b></li>
          <li>
            role: <b>{profile?.role ?? "unknown"}</b>
            {" · "}status: <b>{profile?.status ?? "unknown"}</b>
          </li>
          {profileMissing ? <li>No profiles row matched this account.</li> : null}
          {profileError ? (
            <li>
              profile read failed: <b>{profileError.message}</b>
              {profileError.code ? " (" + profileError.code + ")" : ""}
            </li>
          ) : null}
        </ul>

        <p className="muted small mt-4">{fix}</p>

        <p className="mt-4" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button variant="primary" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? "Rechecking…" : "Recheck my role"}
          </Button>
          <Button as="a" href="#/dashboard" variant="ghost" size="sm">
            Back to dashboard
          </Button>
        </p>
      </main>
    );
  }

  return children;
}
