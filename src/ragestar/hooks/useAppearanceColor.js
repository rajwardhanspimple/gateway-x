/* ==========================================================================
   useAppearanceColor — pick a colour per appearance, from JavaScript
   --------------------------------------------------------------------------
   Almost every colour in the kit is a CSS token, so the appearance swap in
   src/styles/appearance-dark.css handles it. A handful are not: they are PROPS
   passed to components that paint to a canvas, where there is no CSS to
   override. The status page's health indicator is the clearest case — it takes
   `color="#0D7A66"`, the light-appearance instrument teal, which measures
   about 2.1:1 on the dark canvas and effectively disappears.

   A stylesheet cannot reach a prop, so those sites need to ask which
   appearance is live. This hook is that question, and it subscribes to
   `ragestar-theme-change` rather than reading `data-theme` once on mount, for
   the same reason AppearanceToggle does: a value read at mount is stale the
   moment the appearance changes.

   Use it ONLY where CSS genuinely cannot reach. A colour that can be a class
   should be a class.
   ========================================================================== */

import { useEffect, useState } from "react";

const EVENT = "ragestar-theme-change";
const DARK = "dark";

function isDarkNow() {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === DARK;
}

/**
 * Returns the active appearance as a boolean.
 * Kept separate from AppearanceToggle's useAppearance so a canvas component can
 * take a colour without importing a button.
 */
export function useIsDarkAppearance() {
  const [dark, setDark] = useState(isDarkNow);

  useEffect(() => {
    const onChange = (e) => {
      const d = e?.detail;
      setDark(d === DARK ? true : d ? false : isDarkNow());
    };
    window.addEventListener(EVENT, onChange);
    /* catch-up read: the attribute may have been written between first render
       and this effect */
    setDark(isDarkNow());
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  return dark;
}

/**
 * Pick between a light-appearance and a dark-appearance colour.
 *
 *   const teal = useAppearanceColor("#0D7A66", "#3db495");
 *
 * Both values are stated at the call site, so the pairing is readable there
 * rather than hidden in a lookup table.
 */
export function useAppearanceColor(lightValue, darkValue) {
  return useIsDarkAppearance() ? darkValue : lightValue;
}
