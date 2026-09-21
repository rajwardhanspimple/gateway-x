# RageStar v4 — design notes

What changed in this pass, why each decision was made, which bundled design
skill it came from, and what the screenshot QA pass caught.

---

## 1. Scope of the change

| Area | Before (v3) | After (v4) |
| --- | --- | --- |
| Auth | none — every CTA pointed at `#/console` | `#/login` + `#/signup`, split-screen shell, fake backend, session store |
| Header | static "Sign in" / "Launch console" | session aware: avatar + org + sign out, or "Sign in" / "Start free" |
| Console | anonymous | identity chip + sign out in the sidebar rail |
| Footer | 4 link columns | 5 columns — new **Account** column |
| Motion | reveal-on-scroll only | String UI scroll-progress layer (`--progress` driven) |
| Background | 3 layers | 10 layers: aurora, mesh, constellation canvas, beams, floor grid, dots, pointer spotlight, scanline, vignette, noise |
| Component kit | ad-hoc markup per page | `sui-*` kit — Button, Field, TextInput, PasswordInput, PasswordStrength, Checkbox, Segmented, Alert, Divider, OAuthButton, Spinner |
| Icons | 9 inline strings in `brand.jsx` | 17-icon inline SVG set in `components/ui/icons.jsx` |

---

## 2. Skill research

The project ships with `ui-ux-pro-max`, `ui-ux-designer` and `3d-ui`. Queries run
through `ui-ux-pro-max/scripts/search.py`:

| Query | Mode | What was applied |
| --- | --- | --- |
| `RageStar` design system | `--design-system` | keep one accent + one secondary; never let a gradient carry meaning that colour alone must carry |
| dark ui surface elevation | `--domain style` | elevation by **border + translucency**, not drop shadows; `--surface` → `--raised` → `--hover` ladder kept at 3 steps |
| accent colour contrast | `--domain color` | cyan `#4fe3ff` fails AA as body text on dark, so it is only used for ≥ 18px display text, icons, borders and fills — light theme swaps it for `#0793b8` |
| type scale pairing | `--domain typography` | display (Space Grotesk) for headings, a **different** grotesque (DM Sans) for body — added as `--font-body`, mono reserved for data/labels |
| landing page hierarchy | `--domain landing` | one primary CTA per viewport; proof (numbers) directly under the hero claim |
| auth form ux | `--domain ux` | single column, labels above fields, inline validation on blur (never on keypress), show-password toggle, explicit password rules visible *before* submit |
| form error states | `--domain ux` | `role="alert"`, focus the first invalid field, never colour-only errors — icon + text |
| react form patterns | `--stack react` | controlled inputs + a `touched` map; a single `submitting` flag driving `aria-busy` and the spinner |

---

## 3. String UI (String Tune)

From the attached tutorial: String Tune drives a registered custom property and
you style from it.

```css
@property --progress {
  syntax: "<number>";
  inherits: true;
  initial-value: 0;
}

.str-rail-fill {
  transform: scaleX(var(--progress));
}
```

`src/lib/stringTune.js` loads `@fiddle-digital/string-tune@1.2.1` from unpkg and
boots it:

```js
const st = StringTune.StringTune.getInstance();
window.StringTuneContext = st;
st.use(StringTune.StringLazy);
st.use(StringTune.StringProgress);
st.start(0);
```

**Offline fallback.** If the script does not arrive within 3.5s, a ~40-line
engine takes over: an `IntersectionObserver` plus a rAF loop write the same
`--progress` value and the same `is-in` / `is-out` classes, so every component
behaves identically with no network. `StringEngineChip` renders which engine is
live (`cdn` vs `local`) — handy in review, trivial to delete.

Primitives in `src/components/string/StringUI.jsx`:

| Component | Behaviour |
| --- | --- |
| `StringProvider` | boots the engine once, re-scans on route change |
| `StringProgress` | raw `--progress` producer for arbitrary children |
| `StringRail` | horizontal telemetry rail that fills with scroll progress |
| `StringSplit` | per-word headline reveal driven by progress, not by a timer |
| `StringLazyImage` | `string="lazy"` image with a blur-up placeholder |
| `StringSpotlight` | pointer-tracked radial glow on a card (`--sx` / `--sy`) |
| `StringEngineChip` | cdn / local badge |

The home page gained a **String UI motion band** before the final CTA: three
spotlight cards, each with a rail at a different fill, plus a `StringSplit`
headline.

---

## 4. Auth architecture

```
src/lib/auth.js            validation + fake network + session store
src/components/auth/       AuthShell (split screen, proof panel, success screen)
src/pages/Login.jsx        password | magic link (segmented), OAuth, SSO
src/pages/Signup.jsx       name/email/org, password + strength, plan, terms
```

- `#/login` and `#/signup` are in `BARE_ROUTES`, so the marketing header/footer
  are suppressed and `body.is-auth-route` locks page scroll on desktop.
- Left rail is the sales panel: live `Fabric` canvas, animated counters, String
  rails, a quote and trust marks. Right side is the form, vertically centred and
  independently scrollable.
- Session: `localStorage["rr-session"]` + an `rr-session-change` event, read via
  `useSession()`. Sign-up ends on a provisioning log that types out, then routes
  to the console.
- Demo triggers: `locked@…` → workspace-locked error; password `wrongpassword`
  on sign in → bad-credentials error.
- Password policy (12 chars, mixed case, digit, symbol) is scored and shown as a
  4-segment meter plus a live rule checklist.

---

## 5. Background system

| z | Layer | Note |
| --- | --- | --- |
| 0 | aurora | two drifting radial blobs, 28s / 34s |
| 0 | mesh gradient | static, cheap depth |
| 1 | constellation canvas | ≤ 90 nodes, 130px link radius, 14 packets, parallax `scrollY * 0.06` |
| 2 | beams | 3 conic sweeps, 18s |
| 2 | floor grid | perspective-skewed, fades upward |
| 3 | dot matrix | 22px radial-gradient tile |
| 4 | pointer spotlight | rAF-throttled `--mx` / `--my` |
| 5 | scanline | 1px sweep, 9s |
| 6 | vignette + noise | SVG feTurbulence, 3% alpha |

Every animated layer is disabled under `prefers-reduced-motion`.

---

## 6. Screenshot QA — defects found and fixed

Each screen was rendered headless at 1440px (plus 390px mobile) and inspected.

1. **Auth left rail overflowed at 900px height** → flex shell, aside padding
   trimmed, proof canvas 208 → 172px, and `max-height` tiers that shed the
   quote, then the rails/marquee, then the whole proof panel.
2. **Sign-up form started below the fold on mobile** → at ≤ 760px the rail
   collapses to a compact bar; features, marquee and trust marks are hidden.
3. **Stray HUD glyph floating mid-card** → `.str-spot > *:not(.str-spot-glow)`
   was giving the zero-size `.hud-c` span a containing block; now excluded, so
   the corner brackets land on the card corners again.
4. **Proof console washed out in light theme** → explicit
   `[data-theme="light"] .auth-proof` overrides keep that panel dark so the
   canvas keeps its contrast.
5. **Spotlight cards had ragged rail baselines** → card body is a flex column and
   the rail is pushed down with `margin-top: auto`.
6. **"most popular" flag blended into the gradient border** → `.plan-flag` gets
   an opaque `--surface-solid` backing, a cyan ring, `z-index: 3`.
7. **Console avatar showed the fallback initials** → `initials()` takes the
   session object, not a string; the call site was passing a string.

Re-captured after every fix: home (dark + light), the motion band, pricing,
console (signed out + signed in), footer, login (dark + mobile), sign-up
(dark + light).

---

## v5.5 — vector + motion pass

The brief: high-quality SVG and real animation, no generated-looking filler.

### The SVG system

Every mark is hand-built vector geometry on a stated grid — no raster art, no
icon-font, no decorative blobs.

| Asset | Grid | Where |
| --- | --- | --- |
| Brand mark | 32 | `components/brand.jsx` — plate, three-wire fan, one live signal |
| Icon set | 24, stroke 1.7 | `components/brand.jsx` (`ICONS`) |
| Request-path diagram | 640 × 380 | `components/art/RouteDiagram.jsx` |
| Section glyphs | 48 | `components/art/Glyphs.jsx` |
| Closing arcs | 1200 × 420 | `components/art/Glyphs.jsx` (`CtaArcs`) |
| Background weave | tiled pattern | `components/Background.jsx` |

Every animated stroke carries `pathLength="1"`, so a dash-draw is written as
`stroke-dasharray: 1; stroke-dashoffset: 1` and is independent of the real path
length. Gradients are referenced by id (`rrg`, `bootg`, `cta-g`) rather than
baked into fills, so both themes reuse the same geometry.

The diagram is the one piece of real explanatory art: callers on the left, your
gateway in the middle, the origin side inside a dashed vault. Request and
response packets ride the actual wire geometry via `offset-path: path(...)`
passed down as a CSS custom property, so a packet can never drift off its wire.
Upstream names are drawn as masked bars — the redaction is the picture.

### Motion rules

1. Motion explains or it does not ship. Packets travel the request path; the
   brand signal runs source → nodes; glyphs draw once when their section
   arrives.
2. Draw on arrival, not on loop. One `IntersectionObserver`
   (`components/art/Reveal.jsx`) adds `rv-in`; strokes draw, fills settle.
3. Ambient loops stay slow and few: 6–9s, linear, low contrast.
4. The headline reveals word by word, never character-by-character glitch.
5. Scroll-linked flourishes are opt-in behind
   `@supports (animation-timeline: view())`, with a static fallback.
6. `prefers-reduced-motion` stops every loop and leaves each drawing complete.

### Removed

- Canvas constellation with cursor-gravity particles
- Aurora blobs, spinning beams, drifting floor grid, scanline sweep, grain film
- The fake boot log (invented edge regions, provider counts, cache state);
  the loader now shows a mark that draws and real elapsed progress
- Fabricated hero telemetry — the stats strip reads `route_health` and says so

### Visual QA

No network in the build sandbox, so the folds were mirrored in a static harness
(`qa/landing.html`) against the real stylesheets and captured with headless
Chromium at 1440 dark, 1440 light and 390 mobile. Fixes found that way: the code
fold never collapsed below 1040px, the diagram shrank past legibility on mobile
(now floors at 520px and scrolls in its frame), the closing arcs were missing
`pathLength`, and the CTA column was too narrow for its headline.

---

## v6.0 — the minimal pass

`src/styles/minimal.css` is imported **last** in `src/main.jsx` and owns the
current look. The older sheets (`styles.css`, `background.css`,
`string-ui.css`, `art.css`) are still loaded for structure and spacing; the
minimal sheet re-declares the tokens and flattens everything decorative.

What changed, and why:

| Before | Now |
| --- | --- |
| Near-black canvas, cyan/violet gradients, glows | `#191919` / `#ffffff` surfaces, one blue accent, borders instead of shadows |
| Animated background fabric, preloader, route wipe | Removed from `App.jsx` entirely — header, page, footer |
| Reveal-on-scroll, split-text headlines, glyph art | Plain markup; the route drawing on the landing page is now a four-row table |
| Auth pages with fabric + spotlight card | Plain split screen, bordered card |
| Pill tabs, gradient buttons | Underlined tabs, flat buttons |

Decorative components were **unreferenced**, not just hidden: `Background.jsx`,
`Preloader.jsx`, `Fabric.jsx`, `string/StringUI.jsx` and `art/*` are no longer
imported by `App.jsx`, `AuthShell.jsx` or `Home.jsx`. The files are left in the
tree so nothing else breaks, and can be deleted once you are happy.

### New shared components

- `components/ui/DataTable.jsx` — the table used everywhere new: sortable
  headers (3-click cycle), optional search, paging, dense mode, sticky header,
  right-aligned numerics, `Chip` and `CellRow` helpers. Classes are `.dt-*`.
- `components/ui/FileSystem.jsx` — tree + detail pane (`role="tree"`, roving
  tabindex, arrow/enter keyboard nav) plus `FileDetail`, `FileSection` and
  `KeyValues` (a `.mn-kv` two-column table). Classes are `.fsx-*`.
- `.mn-*` utilities in `minimal.css` for page heads, stat rows, cards, fields,
  inline rows and the warn/bad/good message blocks.

### New screens

- `pages/admin/FilesTab.jsx` — the file system over upstreams, keys and models.
- `pages/admin/RoutingTab.jsx` — deadlines and key-rotation settings.

Both degrade gracefully: if `supabase/upgrade-v6.0-timeouts.sql` has not been
run they fall back to the read-only data that already exists and say so.

## v7.0 — the interaction pass

### 1. What was actually broken

The landing route was dead, not dull: `CtaArcs` was used in `Home.jsx` and
never imported, so `ErrorBoundary` caught a `ReferenceError` and replaced the
page. Every other route was fine. Found by rendering all ten routes in headless
Chromium against a stubbed Supabase client and reading `pageerror`, rather than
by reading the source and guessing.

### 2. Response, not decoration

The brief was "more interactive, not dull, not gradient", so the layer only
reacts to intent — hover, press, focus, scroll arrival, value change. No
ambient loops, no gradients, no colour washes. Movement is 1-2px, durations are
120/180/260ms on one shared easing curve, and colour changes reuse existing
tokens (`--primary`, `--primary-soft`, `--border-strong`) so light and dark both
work without a second palette.

The one piece of genuinely new interaction is the landing request-path stepper:
four stages, each clickable and focusable, swapping a description line. It
replaced a decorative SVG arc that carried a gradient.

### 3. Defects the renders caught

Four real bugs, none of which were visible in the source:

1. **Hover did nothing on cards.** `[data-reveal].rv-armed.is-in { transform:
   none }` tied on specificity with `.rr-step:hover` and won on order. Reveals
   moved to the standalone `translate` property, which no longer competes with
   `transform`.
2. **Cards sat 24px low and jumped on hover.** Reusing the legacy
   `[data-reveal]` attribute inherited `translateY(24px)` from `styles.css`.
   Renamed the attribute to `data-rv`.
3. **Table row accents never painted.** `box-shadow` on a `<tr>` is dropped
   under `border-collapse: collapse`; the accent moved to `td:first-child`.
4. **Step icons were invisible.** The icon strings in `brand.jsx` carry only a
   `viewBox`, so an unsized `<svg>` measured 0x0 inside the flex plate. Sized
   explicitly at 18px.

One finding was a false alarm worth recording: a programmatic `el.focus()`
never matches `:focus-visible`, so the focus ring looked missing until the pass
was rewritten to send real `Tab` presses. A header floating mid-page in a
full-page screenshot is likewise a capture artefact of `position: fixed`, not a
layout bug — confirmed by measuring `top` at `scrollY: 0`.

### 4. Key watch design

A 15-second loop that hits real upstreams needs guard rails, so `KeyWatch`
holds a `busyRef` (passes cannot overlap), pauses on `document.hidden`, stops
itself after three consecutive failures, and keeps the countdown in refs so
re-renders do not restart it. `run()` is never called from inside a state
updater, because StrictMode double-invokes those in development and would fire
two checks per tick.

### 5. v11.2 — the dashboard goes back to normal

v11.1 gave the admin dashboard and the console overview their own dark shell:
a grouped sidebar, a command pill, a topbar, and a chart set drawn from
scratch. Looked at on its own it was fine. Mounted in the real app it was not,
because neither of those screens owns the chrome — `Admin.jsx` already renders
the rail and the topbar, and `Console.jsx` already renders the tab strip. The
tab was drawing a second navigation *inside* the first one, and the dark
stylesheet it appended to `<body>` leaked into the other fourteen tabs.

So both tabs are plain tabs again. They render content and nothing else.

**Removed:** `src/styles/vaulto.css`, `src/styles/vaulto-shell.css`,
`src/components/VtShell.jsx`, `src/components/charts.jsx`, `VAULTO-UI.md`, and
the two stylesheet imports in `src/main.jsx`.

**Kept, unchanged:** the key watch system in full — the card, the edge
function, both migrations, the Cloudflare cron worker and the doctor script.
The watcher was never the problem; only the skin wrapped around it was.

**Kept, rebuilt:** every figure the dark version added is still on the page,
drawn with the existing `ap-*` / `adm-*` / `con-*` vocabulary. The one chart
with no existing class — the requests-per-hour columns — is inline-styled
against theme tokens, so the tab cannot reference a class that no stylesheet
defines, and it follows light and dark for free.

Both tabs kept their prop signatures, so `Admin.jsx` and `Console.jsx` needed
no edit, and neither tab adds a fetch: every number is derived from data the
page had already loaded.

#### Tests

`npm test` runs three suites, all offline, none of which need a browser, a
server or a deployed project:

| Command | What it proves |
| --- | --- |
| `npm run test:ui` | every file parses; rules of hooks hold on the real syntax tree; every relative import resolves; every `className` exists in a stylesheet; the removed layer is gone; both tabs render content only and still read the props their parents pass |
| `npm run test:render` | both tabs actually render through `react-dom/server`, twice each — once with populated data and once with a null summary, no keys, no logs and no handlers, which is what a fresh account looks like |
| `npm run test:keywatch` | the watch chain is wired end to end: `verify_jwt = false` on the function, `--no-verify-jwt` on both deploy scripts, both migrations present, the shared-secret header sent by the worker and required by the function, the cron schedule, and the card mounted on both screens |

Two notes on how these are built, because the first attempts were wrong in
instructive ways.

The hooks check started as a regex for `^  return`. It reported 281
violations, every one false: it was finding the return of a small helper
declared above a component and calling every hook below it "after the
return". Text matching cannot tell a helper from a component, so the check now
walks the real syntax tree, tracks function scopes, and flags the three things
that matter — a hook outside a component or hook, a hook inside a condition,
loop, switch or try, and a hook after an early return, which is the specific
bug that took the panel down in v11.0.

The render test needs three substitutions to run outside Vite: `firebase` and
`@supabase/supabase-js` are stubbed, `import.meta.env` becomes a plain object,
and JSX is transformed by `tsx` or by the esbuild inside Vite, whichever is
installed. Everything else is the real code. If none of those transforms is
available the suite prints SKIP and exits 0 — a test that cannot run has not
failed.
