import React, { useEffect, useState } from "react";
import { ICONS, SafeSvg, Logo } from "./brand.jsx";
import { useSession, initials, signOut } from "../lib/auth.js";
import { PaletteTrigger } from "./ui/CommandPalette.jsx";

/* v9 header: a single 52px rule across the top. Mono uppercase labels on the
   left, account + one solid action on the right. No gradient, no glow, no
   transparent-over-navy special case — the same bar on every page. */

const NAV = [
  { label: "Home", path: "#/" },
  { label: "Models", path: "#/models" },
  { label: "Pricing", path: "#/pricing" },
  { label: "Docs", path: "#/docs" },
  { label: "Status", path: "#/status" },
];

export default function Header({ route, theme, onToggleTheme }) {
  const [open, setOpen] = useState(false);
  const { isAuthed, isAdmin, profile, user } = useSession();

  useEffect(() => setOpen(false), [route]);

  const email = profile?.email || user?.email || "";
  const name = profile?.full_name || email.split("@")[0] || "Account";

  const onSignOut = async () => {
    setOpen(false);
    await signOut();
  };

  return (
    <header className="site-header">
      <div className="container">
        <a className="brand" href="#/" aria-label="RageStar home">
          {/* the mark is also the landing target for the route loader */}
          <Logo size={26} />
          <span className="brand-name">Rage<span className="dim">Star</span></span>
        </a>

        <nav aria-label="Main">
          <ul className="nav-links">
            {NAV.map((n) => (
              <li key={n.path}>
                <a href={n.path} aria-current={route === n.path ? "page" : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
            {/* Dashboard stays out of the primary nav — it lives in the utility
                actions on the right, so the menu is not carrying the same link
                twice. The community portal is a deep link into the dashboard. */}
            {isAuthed ? (
              <li>
                <a href="#/dashboard/community">Community</a>
              </li>
            ) : null}
            {isAdmin ? (
              <li>
                <a href="#/admin" aria-current={route === "#/admin" ? "page" : undefined}>Admin</a>
              </li>
            ) : null}
          </ul>
        </nav>

        <div className="nav-actions">
          {/* Opens the command palette. Keeping it in the bar means the
              Cmd/Ctrl+K layer is discoverable without a keyboard. */}
          <PaletteTrigger />

          <button
            className="theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "paper" : "ink"} palette`}
            title={theme === "dark" ? "Paper palette" : "Ink palette"}
          >
            <SafeSvg markup={ICONS.sun + ICONS.moon} />
          </button>

          {isAuthed ? (
            <>
              <span className="hdr-user desktop-only" title={email}>
                <span className="hdr-avatar" aria-hidden="true">{initials(profile?.full_name || email)}</span>
                <span className="hdr-user-meta">
                  <b>{name}</b>
                  <small>{profile?.org || email}</small>
                </span>
              </span>
              <button className="btn btn-ghost btn-sm desktop-only" type="button" onClick={onSignOut}>
                Sign out
              </button>
              <a className="btn btn-primary btn-sm" href="#/dashboard">Dashboard</a>
            </>
          ) : (
            <>
              <a className="btn btn-ghost btn-sm desktop-only" href="#/login">Log-in</a>
              <a className="btn btn-primary btn-sm" href="#/signup">Sign-up</a>
            </>
          )}

          <button
            className="theme-toggle nav-burger"
            type="button"
            onClick={() => setOpen(!open)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            <SafeSvg markup={open ? ICONS.close : ICONS.menu} />
          </button>
        </div>
      </div>

      <div className={`mobile-nav ${open ? "open" : ""}`}>
        {NAV.map((n) => (
          <a key={n.path} href={n.path}>{n.label}</a>
        ))}
        {isAuthed ? <a href="#/dashboard/community">Community</a> : null}
        {isAdmin ? <a href="#/admin">Admin</a> : null}
        {isAuthed ? (
          <button type="button" className="mobile-signout" onClick={onSignOut}>Sign out</button>
        ) : (
          <>
            <a href="#/login">Log-in</a>
            <a href="#/signup">Sign-up</a>
          </>
        )}
      </div>
    </header>
  );
}
