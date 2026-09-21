import React from "react";
import { sanitizeSvg } from "../lib/sanitize.js";

/* ---------------------------------------------------------------------------
   Brand + icon set.

   One 24x24 grid, one stroke weight (1.7 for content icons, 1.9 for window
   chrome), round caps and joins everywhere, no fills. Icons are stored as
   strings because the header, code blocks and console inject them inline.
--------------------------------------------------------------------------- */

const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const CHROME = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  sun: `<svg class="i-sun" viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.6 12h2.2M19.2 12h2.2M6.2 17.8l-1.6 1.6M19.4 4.6l-1.6 1.6"/></svg>`,
  moon: `<svg class="i-moon" viewBox="0 0 24 24" ${S}><path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8Z"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" ${CHROME}><path d="M3.8 7.5h16.4M3.8 12h16.4M3.8 16.5h16.4"/></svg>`,
  close: `<svg viewBox="0 0 24 24" ${CHROME}><path d="M17.8 6.2 6.2 17.8M6.2 6.2l11.6 11.6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" ${S}><rect x="9" y="9" width="11.5" height="11.5" rx="2.6"/><path d="M15 6.2V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v6.5A2.5 2.5 0 0 0 6 15h.2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 6.8 9.4 16.9l-4.9-4.9"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" ${S}><path d="M4.5 12h14.2M12.8 6.2 18.8 12l-6 5.8"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" ${S}><path d="M13.2 2.8 5.4 13.4h5.3L9.9 21.2l8-11h-5.3l.6-7.4Z"/></svg>`,
  route: `<svg viewBox="0 0 24 24" ${S}><circle cx="5.8" cy="12" r="2.6"/><circle cx="18.2" cy="6.2" r="2.2"/><circle cx="18.2" cy="17.8" r="2.2"/><path d="M8.3 11 16 7.2M8.4 12h7.6M8.3 13l7.7 3.8"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" ${S}><path d="M12 3.2 5.4 6v5.1c0 4.3 2.7 8 6.6 9.7 3.9-1.7 6.6-5.4 6.6-9.7V6L12 3.2Z"/><path d="m9.4 11.9 2 2 3.4-4"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" ${S}><rect x="4.8" y="10.4" width="14.4" height="9.8" rx="2.6"/><path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6M12 14.2v2.4"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="4.4" width="18" height="15.2" rx="2.6"/><path d="m7.6 10 2.4 2.4-2.4 2.4M12.8 14.8h3.6"/></svg>`,
  cache: `<svg viewBox="0 0 24 24" ${S}><path d="M4.4 6.2c0-1.7 3.4-3 7.6-3s7.6 1.3 7.6 3-3.4 3-7.6 3-7.6-1.3-7.6-3Z"/><path d="M4.4 6.2v11.6c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3V6.2"/><path d="M4.4 12c0 1.7 3.4 3 7.6 3s7.6-1.3 7.6-3"/></svg>`,
  chart: `<svg viewBox="0 0 24 24" ${S}><path d="M4.2 19.8V4.2M4.2 19.8h15.6"/><path d="m7.4 14.2 3.6-4.6 2.8 2.8 4.8-6.6"/></svg>`,
  gauge: `<svg viewBox="0 0 24 24" ${S}><path d="M4.2 16.8c2.8-1 3.8-7.6 7.6-7.6 2.8 0 3.3 3.3 5.7 3.3 1.1 0 1.9-.5 1.9-.5"/><path d="m17.4 15.8 2.9-3.4-3.3-3.3"/></svg>`,
  coins: `<svg viewBox="0 0 24 24" ${S}><circle cx="9.2" cy="9.2" r="5.8"/><path d="M14.3 5.9a5.8 5.8 0 1 1-5.1 12.2"/><path d="M7.2 9.2h4M9.2 7.2v4"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" ${S}><path d="M2.4 12S6 5.4 12 5.4 21.6 12 21.6 12 18 18.6 12 18.6 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  key: `<svg viewBox="0 0 24 24" ${S}><circle cx="8.2" cy="15.2" r="3.8"/><path d="m11 12.4 7.8-7.8M15 5.6l2.8 2.8M17.8 2.8l2.8 2.8"/></svg>`,
  play: `<svg viewBox="0 0 24 24" ${S}><path d="M7.6 5.6v12.8L18.4 12 7.6 5.6Z"/></svg>`,
  book: `<svg viewBox="0 0 24 24" ${S}><path d="M4.2 18.4V5.8a2.4 2.4 0 0 1 2.4-2.4h13.2v15.2H6.6a2.4 2.4 0 0 0-2.4 2.4V18.4Z"/><path d="M4.2 18.4a2.4 2.4 0 0 0 2.4 2.2h13.2"/></svg>`,
  home: `<svg viewBox="0 0 24 24" ${S}><path d="m3.4 11.2 8.6-7.8 8.6 7.8"/><path d="M5.6 10v10.2h12.8V10"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" ${S}><circle cx="12" cy="12" r="3"/><path d="M18.9 12c0-.4 0-.8-.1-1.2l1.9-1.5-1.9-3.3-2.3 1a6.9 6.9 0 0 0-2-1.2L13.9 3.3h-3.8L9.5 5.8a6.9 6.9 0 0 0-2 1.2l-2.3-1-1.9 3.3 1.9 1.5c0 .4-.1.8-.1 1.2s0 .8.1 1.2l-1.9 1.5 1.9 3.3 2.3-1a6.9 6.9 0 0 0 2 1.2l.6 2.5h3.8l.6-2.5a6.9 6.9 0 0 0 2-1.2l2.3 1 1.9-3.3-1.9-1.5c.1-.4.1-.8.1-1.2Z"/></svg>`,
  card: `<svg viewBox="0 0 24 24" ${S}><rect x="2.6" y="5.2" width="18.8" height="13.6" rx="2.6"/><path d="M2.6 9.8h18.8M6.4 14.8h3.4"/></svg>`,
  list: `<svg viewBox="0 0 24 24" ${S}><path d="M8.4 6.2h12.2M8.4 12h12.2M8.4 17.8h12.2M3.6 6.2h.02M3.6 12h.02M3.6 17.8h.02"/></svg>`,
};

/* ---------------------------------------------------------------------------
   Logo: a routing mark on a 32 grid. One source node on the left, three
   destinations on the right, and a signal that runs the middle wire on hover
   (see .bm-* rules in styles/art.css).
--------------------------------------------------------------------------- */
export function Logo({ size = 30 }) {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ width: size, height: size }}
    >
      <defs>
        <linearGradient id="rsg" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4fe3ff" />
          <stop offset="1" stopColor="#8f7bff" />
        </linearGradient>
      </defs>

      <rect
        className="bm-plate"
        x="1.15"
        y="1.15"
        width="29.7"
        height="29.7"
        rx="9.2"
        stroke="url(#rsg)"
        strokeWidth="1.3"
        strokeOpacity="0.9"
        fill="rgba(79,227,255,.06)"
      />

      <path
        d="M11.4 15.1 20.5 10.1M11.5 16h9.1M11.4 16.9l9.1 5"
        stroke="url(#rsg)"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeOpacity="0.55"
      />
      <path
        className="bm-signal"
        d="M11.5 16h9.1"
        pathLength="1"
        stroke="#4fe3ff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />

      <circle cx="8.6" cy="16" r="2.7" fill="url(#rsg)" />
      <circle className="bm-node bm-node-1" cx="22.9" cy="9.6" r="2.05" fill="#4fe3ff" />
      <circle className="bm-node bm-node-2" cx="22.9" cy="16" r="2.05" fill="#8f7bff" />
      <circle className="bm-node bm-node-3" cx="22.9" cy="22.4" r="2.05" fill="#4fe3ff" fillOpacity="0.72" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
   RageStarMark: the mark of the UI kit the whole site now runs on.

   Every routed screen is a RageStar screen, so the boot plate and the
   screen-to-screen hand-off fly this triangle — not the gateway's routing
   mark — into the kit's logo tile (.pr-brand-mark). Same 32 grid, cobalt,
   no gradient ids (the plate renders twice at once during a transition, and
   duplicate SVG gradient ids would fight over the same paint server).
--------------------------------------------------------------------------- */
export function RageStarMark({ size = "100%" }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ width: size, height: size }}
    >
      <rect
        x="1.15"
        y="1.15"
        width="29.7"
        height="29.7"
        rx="9.2"
        stroke="#2447E8"
        strokeOpacity="0.32"
        strokeWidth="1.3"
        fill="rgba(36,71,232,.06)"
      />
      <path d="M16 5.6 27 25.6H5L16 5.6Z" stroke="#2447E8" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M16 5.6v20" stroke="#2447E8" strokeOpacity="0.6" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M9.4 18.2h13.2" stroke="#2447E8" strokeOpacity="0.45" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function Icon({ name, ...rest }) {
  return (
    <span
      dangerouslySetInnerHTML={{ __html: sanitizeSvg(iconMarkup(name)) }}
      style={{ display: "inline-flex" }}
      {...rest}
    />
  );
}

/* ---------------------------------------------------------------- safe SVG */

/* Own-property lookup only: ICONS[name] with an attacker-controlled name could
   otherwise return inherited members such as "constructor". */
export function iconMarkup(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : "";
}

/**
 * The single sanctioned way to put inline SVG into the DOM.
 *
 * Every icon string is run through the allow-list sanitiser in lib/sanitize.js
 * first, so <script>, on* handlers, javascript: URLs and <foreignObject> can
 * never reach the page — even if an icon one day comes from the database.
 */
export function SafeSvg({ markup, ...rest }) {
  return <span {...rest} dangerouslySetInnerHTML={{ __html: sanitizeSvg(markup) }} />;
}
