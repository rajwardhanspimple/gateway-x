import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { completeDiscordCallback } from "./lib/discord.js";
import "./styles.css";
/* The RageStar UI kit (the #/ragestar console) is imported EARLY on purpose.
   Tailwind emits its theme tokens on an unlayered :root, and some names
   (--font-display, --font-mono, --ease-out) collide with the gateway's own
   tokens. Loading the kit first lets every gateway sheet below re-assert its
   values for the site; inside .ragestar-scope the kit's scoped variable block
   still wins, because a variable set directly on an element always beats one
   inherited from :root. The kit's utilities live in @layer utilities, so
   they can never restyle the gateway either. See src/ragestar/theme.css. */
import "./ragestar/theme.css";
import "./styles/background.css";
import "./styles/string-ui.css";
import "./styles/auth.css";
import "./styles/art.css";
/* Loaded last on purpose: minimal.css is the current look and quietly
   overrides the decorative layers above (gradients, glows, animation). */
import "./styles/minimal.css";
/* …and after it, the response layer: hover, press, focus, reveal and the
   live-state signals minimal.css clamped. Solid colours only, no gradients. */
import "./styles/interactive.css";
/* v9 "grid paper" — the current look, loaded last so it wins everywhere.
   Unlike the old landing sheet this one re-declares the design tokens, so the
   console, the admin panel and the auth screens follow the same palette
   instead of keeping the previous flat-grey one. */
import "./styles/flim.css";
/* Console repairs that have to outrank flim.css. App.jsx's console-tabs.css
   is imported before this file's stylesheets (App.jsx is imported first), so
   flim.css was overriding the tab strip with its vertical-rail rules and the
   tabs ended up off-screen. This sheet also holds the playground layout. */
import "./styles/console-v10.css";
/* Motion last of all: minimal.css clamps animation-duration globally, so the
   arrival/stagger/stream layer has to re-open it selector by selector. */
import "./styles/motion.css";
/* v10 interaction layer, loaded after everything else so the focus rings,
   toasts, command palette, tooltips and hit-area rules win without needing
   !important. Reads the flim.css tokens, so both themes come for free. */
import "./styles/interactions.css";

import "./styles/admin-panel.css";
import "./styles/kie.css";
/* the spreadsheet usage grid (components/ui/SheetGrid.jsx) */
import "./styles/sheet.css";
import "./styles/community.css";
/* v11 console shell. Loaded after every other sheet because it owns the
   console geometry: the split grid, the stack tracks (the overlap fix), the
   wider container, the bigger stat tiles and the taller tab bar. */
import "./styles/console-v11.css";

/* v11 landing: the hero float canvas kept collisions between the drifting
   cards and the compressor bar. This sheet reserves a corridor for the bar
   and turns the scatter into a plain grid below 1100px. */
import "./styles/landing-v11.css";
/* the screen-to-screen loading plate (see components/RouteLoader.jsx) */
import "./styles/route-loader.css";
/* v12 "rail" — the unified dashboard at #/dashboard. Loaded last of all the
   layout sheets so it owns its own geometry outright: the rail, the sticky
   top bar, the pulse row and the single canvas every section paints into,
   including the community portal, which no longer has a page of its own. */
import "./styles/dashboard-v12.css";
/* the admin panel on that same shell: accent, section search, message inbox */
import "./styles/admin-v12.css";
/* the staff console on the RageStar paper theme: re-skins the real admin panel's
   ap-, adm- and sui- prefixed surfaces when it mounts inside .ragestar-admin */
import "./styles/admin-ragestar.css";
import "./styles/dashboard-snow.css";
import "./styles/community-v12.css";
/* v12.7 announcements strip — tones reuse the alert palette tokens, so both
   themes come for free. */
import "./styles/announcements.css";
/* RageStar token bridge, absolutely last: the global layers that render outside
   .ragestar-scope (route plate, toasts, command palette, back-to-top) still read
   the gateway's :root tokens, so this re-declares those token names with
   RageStar values on those four roots. See the header in src/ragestar/chrome.css. */
import "./ragestar/chrome.css";
/* The dark appearance, after chrome.css and therefore after everything.
   It has to be last for two reasons: it re-declares the kit's @theme token
   names under [data-theme="dark"] .ragestar-scope, and it undoes the paper
   values chrome.css pins onto the four out-of-scope layers with its own
   [data-theme="dark"] rules. Tokens only, so it restyles nothing while the
   light appearance is active. See the header in the file itself and
   APPEARANCE-PLAN.md. */
import "./styles/appearance-dark.css";
/* The staff admin panel in dark. A separate sheet because that panel is NOT
   built from kit utilities — it is the gateway's own panel mounted inside
   .ragestar-admin, skinned by admin-panel.css and admin-ragestar.css with
   literal light hex, which the token swap above cannot reach. Must load after
   both of those sheets. */
import "./styles/appearance-dark-admin.css";
/* The floating light/dark switch (.rs-appearance), mounted once in App.jsx.
   After appearance-dark.css because it reads the gateway token names that file
   re-bridges for the dark appearance. */
import "./styles/appearance-control.css";
/* Contrast and type-size floors, after the palette so it can express its
   thresholds against whichever appearance is active. A STOPGAP: it answers
   the utility class names in the markup instead of editing the 14 kit files
   that carry them. Delete it when those source edits land — do not layer on
   top of it. See the header in the file itself. */
import "./styles/appearance-readability.css";
/* Theme bootstrap.
   This used to be an inline <script> in index.html. Inline scripts are blocked
   by the Content-Security-Policy shipped with the production build, so the
   logic lives here instead. Only two literal values are ever accepted, so a
   tampered localStorage entry cannot inject an attribute value. */
try {
  const stored = localStorage.getItem("ragestar-theme");
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  }
} catch {
  /* private mode / storage disabled — keep the default paper theme */
}

/* A Discord OAuth round trip lands back on the site root with ?code&state on
   the URL (redirect URIs cannot carry a #hash). Consume it before the first
   render: sign-in mode mints a Firebase custom token and hands the session to
   the v10 bridge, connect mode links the identity to the signed-in account.
   A static import, not a dynamic one: the pages import this module too, so
   import() would not split a chunk — it would only warn on every build. No
   cycle either way: lib/discord.js imports config, firebase, firebaseBridge
   and supabase only, never auth.js. */
completeDiscordCallback().catch(() => {
  /* a failed callback must never take the app down with it */
});


createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
