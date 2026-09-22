/* ==========================================================================
   AppearanceToggle — the global light/dark switch
   --------------------------------------------------------------------------
   Mounted ONCE in App.jsx, beside the toaster, the command palette and
   back-to-top. One mount covers all twelve routes, including the auth screens,
   which render no navigation of their own and would otherwise offer no way to
   switch.

   The visible control is AnimatedThemeToggler (ported from Magic UI), which
   wipes the new appearance across the page with a View Transition clip-path
   instead of swapping it instantly. This file owns the CONTRACT that sits under
   it, and that separation matters:

     setAppearance()   the single writer. Sets data-theme on <html>, persists
                       to localStorage["ragestar-theme"], dispatches
                       ragestar-theme-change. Every switch goes through it —
                       this control, the command palette, the keyboard
                       shortcut, the animated toggler.
     useAppearance()   the reader. Subscribes to the event rather than reading
                       the attribute once on mount, which is what leaves a
                       control stale when the appearance changes elsewhere.

   Styling lives in src/styles/appearance-control.css and uses the GATEWAY
   tokens, not the kit's Tailwind utilities: this renders outside
   .ragestar-scope, where `text-white` still resolves to the kit's pine ink, so
   kit utilities would make the button dark-on-dark in the dark appearance.
   ========================================================================== */

import { useCallback, useEffect, useState } from "react";
import { AnimatedThemeToggler } from "./AnimatedThemeToggler.jsx";

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
 * Exported so the command palette, the animated toggler and any future caller
 * share one path rather than each writing the attribute themselves. A storage
 * failure (private mode, storage disabled, quota) must not block the switch:
 * the appearance still applies for the rest of the session.
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

/**
 * The switch.
 *
 * A thin wrapper now: AnimatedThemeToggler renders the button, owns the icon
 * and the View Transition wipe, and calls setAppearance above. The label beside
 * it names the DESTINATION ("Dark", "Light") rather than the current state,
 * because a control labelled for what it currently is leaves the reader
 * guessing what pressing it does. The toggler carries aria-pressed and the
 * aria-label, so the label span is decorative and hidden from assistive tech to
 * avoid announcing the word twice.
 *
 * `fromCenter` is off, so the wipe opens from the button in the bottom-left
 * corner — the reveal starts where the reader clicked.
 */
export default function AppearanceToggle() {
  const { isDark } = useAppearance();

  return (
    <AnimatedThemeToggler className="rs-appearance" variant="circle" duration={450}>
      <span className="rs-appearance-label" aria-hidden="true">
        {isDark ? "Light" : "Dark"}
      </span>
    </AnimatedThemeToggler>
  );
}
