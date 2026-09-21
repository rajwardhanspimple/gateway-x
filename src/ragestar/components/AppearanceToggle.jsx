/* ==========================================================================
   AppearanceToggle — the global light/dark switch
   --------------------------------------------------------------------------
   Mounted ONCE in App.jsx, beside the toaster, the command palette and
   back-to-top. One mount covers all twelve routes, including the auth screens,
   which render no navigation of their own and would otherwise offer no way to
   switch.

   This component does not own the appearance. App.jsx is the writer of
   `data-theme` and of the stored preference. The contract both sides honour:

     write   set data-theme on <html>, persist under "ragestar-theme",
             then dispatch `ragestar-theme-change` carrying the new value
     read    subscribe to that event — never read the attribute once on mount,
             which is what leaves a control stale when the appearance is
             changed from the command palette or the keyboard shortcut

   Styling lives in src/styles/appearance-control.css and uses the GATEWAY
   tokens, not the kit's Tailwind utilities. That matters: this renders outside
   .ragestar-scope, where `text-white` still resolves to the kit's pine ink, so
   kit utilities would make the button dark-on-dark in the dark appearance.
   ========================================================================== */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "ragestar-theme";
const EVENT = "ragestar-theme-change";

const LIGHT = "light";
const DARK = "dark";

/** The live appearance, read from the document. Anything but "dark" is light. */
function currentAppearance() {
  if (typeof document === "undefined") return LIGHT;
  return document.documentElement.getAttribute("data-theme") === DARK ? DARK : LIGHT;
}

/**
 * Apply an appearance app-wide.
 *
 * Exported so the command palette and any future caller share one path rather
 * than each writing the attribute themselves. A storage failure (private mode,
 * storage disabled, quota) must not block the switch: the appearance still
 * applies for the rest of the session.
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
 * Track the active appearance and stay in sync with every other switch.
 * Exported for surfaces that need to know the appearance without rendering a
 * control of their own.
 */
export function useAppearance() {
  const [appearance, setLocal] = useState(currentAppearance);

  useEffect(() => {
    /* Trust the event's detail when it carries one, fall back to the attribute
       otherwise, so a dispatch with no detail resynchronises instead of
       desyncing. App.jsx's own effect dispatches without one. */
    const onChange = (e) => {
      const d = e?.detail;
      setLocal(d === DARK ? DARK : d === LIGHT ? LIGHT : currentAppearance());
    };
    window.addEventListener(EVENT, onChange);

    /* Another tab writing the preference should move this one too. */
    const onStorage = (e) => {
      if (e.key !== STORAGE_KEY) return;
      const value = e.newValue === DARK ? DARK : LIGHT;
      document.documentElement.setAttribute("data-theme", value);
      setLocal(value);
    };
    window.addEventListener("storage", onStorage);

    /* One catch-up read. Between this component's first render and this effect
       running, App.jsx's own theme effect may already have written the
       attribute; without this the first paint of the button could disagree
       with the page for a frame. */
    setLocal(currentAppearance());

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
   Sized explicitly at 18px via .rs-appearance-icon. These viewBox-only SVGs
   measure 0x0 inside a flex parent otherwise, which is the v7.0 step-icon bug
   recorded in DESIGN-NOTES.md. Only one is ever rendered, so there is no
   chance of both showing mid-transition. */

function SunIcon() {
  return (
    <svg
      className="rs-appearance-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4.2" />
      <path
        d="M12 2.6v2.4M12 19v2.4M4.4 12H2M22 12h-2.4M6.1 6.1 4.4 4.4M19.6 19.6l-1.7-1.7M17.9 6.1l1.7-1.7M4.4 19.6l1.7-1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      className="rs-appearance-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20.5 14.3A8.6 8.6 0 1 1 9.7 3.5a6.9 6.9 0 0 0 10.8 10.8Z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The switch.
 *
 * The label names the DESTINATION ("Dark", "Light"), not the current state: a
 * control labelled for what it currently is leaves the reader guessing what
 * pressing it does. `aria-pressed` carries the state instead, announced on the
 * same element the user activated.
 */
export default function AppearanceToggle() {
  const { isDark, toggle } = useAppearance();
  const target = isDark ? "light" : "dark";

  return (
    <button
      type="button"
      className="rs-appearance"
      onClick={toggle}
      title={`Switch to ${target} appearance`}
      aria-label={`Switch to ${target} appearance`}
      aria-pressed={isDark}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
      <span className="rs-appearance-label">{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
