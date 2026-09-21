/* ==========================================================================
   AppearanceToggle — the visible light/dark switch
   --------------------------------------------------------------------------
   The appearance switch was reachable by keyboard only: App.jsx owns the
   state and the command palette binds Cmd/Ctrl+Shift+L, but no screen
   rendered a control, so nobody who did not already know the shortcut could
   find it.

   This component does not own the appearance. App.jsx is the writer of
   `data-theme` and the owner of the stored preference; every other surface
   either calls it or listens to it. The contract:

     write   set data-theme on <html>, persist under "ragestar-theme",
             then dispatch `ragestar-theme-change` with the new value
     read    subscribe to `ragestar-theme-change`, never read the attribute
             once on mount — that is what leaves a control stale when the
             appearance is switched from somewhere else

   The subscription is the whole reason this is a component and not a button:
   four separate surfaces switch the appearance (this control, the command
   palette, the keyboard shortcut, and any other mounted instance), and every
   one of them has to agree on what is currently active.

   Styled with .ragestar-scope utilities so it inherits both palettes from the
   token layer. See src/styles/appearance-dark.css and APPEARANCE-PLAN.md.
   ========================================================================== */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ragestar-theme";
const EVENT = "ragestar-theme-change";

/** The two appearances. Anything else resolves to light. */
const LIGHT = "light";
const DARK = "dark";

function currentAppearance() {
  if (typeof document === "undefined") return LIGHT;
  return document.documentElement.getAttribute("data-theme") === DARK ? DARK : LIGHT;
}

/**
 * Apply an appearance app-wide. Exported so the command palette and any other
 * caller go through one path rather than each writing the attribute directly.
 *
 * A storage failure (private mode, storage disabled, quota) must not block the
 * switch — the appearance still applies for the rest of the session.
 */
export function setAppearance(next) {
  const value = next === DARK ? DARK : LIGHT;
  document.documentElement.setAttribute("data-theme", value);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* session-only is an acceptable degradation; refusing to switch is not */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
  return value;
}

/**
 * Read the active appearance and stay in sync with every other switch.
 * Exported for surfaces that need to know the appearance without rendering a
 * control of their own.
 */
export function useAppearance() {
  const [appearance, setLocal] = useState(currentAppearance);

  useEffect(() => {
    /* The event carries the new value, but fall back to the attribute so a
       dispatch with no detail still resynchronises rather than desyncing. */
    const onChange = (e) => setLocal(e?.detail === DARK ? DARK : e?.detail === LIGHT ? LIGHT : currentAppearance());
    window.addEventListener(EVENT, onChange);
    /* Another tab writing the preference should move this one too. */
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      const value = e.newValue === DARK ? DARK : LIGHT;
      document.documentElement.setAttribute("data-theme", value);
      setLocal(value);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const toggle = useCallback(() => {
    setLocal(setAppearance(currentAppearance() === DARK ? LIGHT : DARK));
  }, []);

  return { appearance, isDark: appearance === DARK, toggle, setAppearance };
}

/* --- icons ---------------------------------------------------------------
   Both are drawn, never swapped by CSS display, so the button has exactly one
   child and no chance of both showing during a transition. 18px explicit:
   these viewBox-only strings measure 0x0 inside a flex parent otherwise,
   which is the bug DESIGN-NOTES.md records for the v7.0 step icons. */

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.4M12 19v2.4M4.4 12H2M22 12h-2.4M6.1 6.1 4.4 4.4M19.6 19.6l-1.7-1.7M17.9 6.1l1.7-1.7M4.4 19.6l1.7-1.7" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M20.5 14.3A8.6 8.6 0 1 1 9.7 3.5a6.9 6.9 0 0 0 10.8 10.8Z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The switch itself.
 *
 * `aria-pressed` carries the state rather than the label, so a screen reader
 * announces the change on the same element the user activated. The label names
 * the destination ("Switch to dark"), because a control named for its current
 * state is ambiguous about what pressing it does.
 */
export default function AppearanceToggle({ className = "" }) {
  const { isDark, toggle } = useAppearance();
  const label = isDark ? "Switch to light appearance" : "Switch to dark appearance";

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={isDark}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/12 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white/90 ${className}`}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
