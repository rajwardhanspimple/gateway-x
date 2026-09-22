# RageStar — appearance and readability plan

The spec for adding a dark appearance to the RageStar UI kit and putting all
text on one contrast ramp and one size scale. Written before the code, in the
same spirit as `DESIGN-NOTES.md`: what was measured, what was decided, and
why each alternative was rejected.

Nothing in this document is implemented yet. It is the plan the six tracked
work orders execute.

---

## 1. What is actually wrong today

Three separate problems, found by reading the tree rather than by looking at
screens.

### The theme switch exists and does nothing

`App.jsx` holds appearance state, writes `data-theme` to the document root,
persists it under `ragestar-theme`, and binds Cmd/Ctrl+Shift+L through the
command palette. `main.jsx` applies the stored value before first paint. The
retired gateway sheets (`styles.css`, `minimal.css`, `flim.css`) each ship a
full `[data-theme="dark"]` palette.

None of it reaches the page. Every routed screen renders inside
`.ragestar-scope`, and `ragestar/theme.css` declares `color-scheme: light`
with no dark counterpart. Worse, `ragestar/chrome.css` deliberately pins the
four out-of-scope layers (route plate, toasts, command palette, back-to-top)
to paper values *including* under `[data-theme="dark"]`.

So the plumbing is complete and the palette is missing.

### Text is already too faint, in the light theme

The kit's token naming is inverted on purpose: `--color-white` is `#101814`
(pine ink) and `--color-ink-950` is `#e9ece4` (paper). So `text-white/55`
means "ink at 55% on paper". Measured against the page canvas:

| Utility | Ratio | Occurrences |
| --- | --- | --- |
| `text-white/30` to `/45` | 2.5:1 to 3.2:1 | 137 |
| `text-white/50` to `/60` | 3.4:1 to 4.45:1 | 76 |
| `text-white/65` and up | 5.2:1 and up | 148 |

213 text occurrences sit below the 4.5:1 body-text threshold right now, in the
only theme that ships. `npm run test:contrast` reports clean, which is the
next problem.

### There is no type scale

460 arbitrary `text-[Npx]` values across 24 distinct sizes, including 36
body-copy occurrences below 12px. `minimal.css` had set a deliberate 14px
floor ("nothing smaller anywhere") and the kit broke it.

---

## 2. Why the token swap, and not the two obvious alternatives

The kit is roughly 800 colour-bearing classNames across 14 files.

**Rejected: a Tailwind `dark:` variant.** Doubles every colour decision and
puts the burden on every future component.

**Rejected: a dark stylesheet appended last.** The repository already tried
this. `DESIGN-NOTES.md` section v11.2 records the v11.1 "vaulto" sheet, which
leaked into fourteen unrelated tabs and was reverted wholesale. A stylesheet
cannot reach the 143 literal hex values sitting in JSX, so dark mode would
ship visibly half-broken.

**Chosen: override the `@theme` tokens under `[data-theme="dark"] .ragestar-scope`.**
Because the naming is already inverted, 361 `text-white/N` occurrences and
every `bg-ink-*` surface invert correctly from a single palette swap.

The catch, and the reason for the sequencing below: the swap only reaches
components that resolve tokens. 143 literal hex occurrences across 13 files
must be converted first.

| Hex | Count | Role |
| --- | --- | --- |
| `#2447E8` | 33 | cobalt accent |
| `#e9ece4` | 33 | paper |
| `#101814` | 24 | pine ink |
| `#E23D28` | 10 | signal red |
| `#0D7A66` | 10 | instrument teal |
| `#f4f6ee` | 10 | raised paper |
| `#C79A1E` | 7 | brass |
| `#f1f3eb` | 5 | glass card |
| `#1630B8` | 3 | deep cobalt |
| others | 8 | dotmatrix, one rose stop |

Plus around 25 `rgba(16,24,20,...)` literals. `components/Ambient.jsx` is the
worst case: a literal `COLORS` array plus inline gradients, vignette and grain.

---

## 3. The dark palette

Derived from the current appearance rather than revived from one of the three
dead palettes still in the tree. Those belong to abandoned looks; reviving one
would reintroduce a design nobody chose.

The two extremes swap: the light theme's ink becomes the dark theme's page,
and the light page becomes the dark ink. Only the four middle tints are
re-derived, because paper tints are far too light to serve as dark surfaces.

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `--color-ink-950` | page canvas | `#e9ece4` | `#101814` |
| `--color-ink-900` | raised, card | `#e2e6da` | `#171e1a` |
| `--color-ink-850` | hover | `#dbe0d2` | `#1c241f` |
| `--color-ink-800` | sunken | `#d3d9c8` | `#222b25` |
| `--color-ink-700` | strongest tint | `#c5cdba` | `#2b352e` |
| glass card | `pr-glass` fill | `#f1f3eb` | `#171e1a` |
| `--color-white` | full-strength ink | `#101814` | `#e9ece4` |

Full-strength ink measures 15.1:1 on the page canvas in both themes.

### The ink ramp

| Tier | Role | On light page | On dark page |
| --- | --- | --- | --- |
| 85% | primary, numeric | 10.1:1 | 11.1:1 |
| 70% | secondary | 6.1:1 | 7.8:1 |
| 65% | label | 5.2:1 | 7.0:1 |
| 60% | **not permitted for text** | 4.4:1 | 6.3:1 |

The light theme is the binding case. 65% is the lowest tier that clears 4.5:1
there; 60% fails it. One ramp therefore serves both themes and the dark side
has headroom to spare. Lower opacities stay legal on borders, dividers, fills
and decorative marks, meaning anything carrying no text.

### Status accents

Three of the four accents fail as text on the light page today. They were
chosen as fill colours and then reused for type.

| Meaning | Light fill | Light text | Dark fill and text |
| --- | --- | --- | --- |
| accent (cobalt) | `#2447e8` | `#2447e8` at 5.6:1 | `#6e9bf5` at 6.6:1 |
| healthy (teal) | `#0d7a66` | `#0a6353` at 6.0:1 | `#3db495` at 7.0:1 |
| failed (red) | `#e23d28` | `#a82310` at 6.0:1 | `#f2705c` at 6.2:1 |
| warning (brass) | `#c79a1e` | `#7a5a0a` at 5.3:1 | `#d9ae3a` at 8.7:1 |

As text on paper, teal measures 4.4:1, red 3.6:1 and brass 2.2:1 today. Each
accent therefore needs two tokens, a fill and a text value, in both themes.
`#0a6353` and `#a82310` already exist as the `lime-300` and `rose-200` stops.
`#7a5a0a` is new: the current darkest brass, `#8f6a0d`, measures 4.15:1 and
still misses.

Every dark accent doubles as its own text value, because the dark canvas is
dark enough that the fill already clears the threshold.

---

## 4. The type scale

Seven tokens replace 24 ad-hoc values. Both themes share it. The kit's
existing display heading steps are unaffected.

| Token | Size | Used for |
| --- | --- | --- |
| `--text-body-lg` | 15px | lead paragraphs, card intros |
| `--text-body` | 14px | default body copy, list items, form values |
| `--text-body-sm` | 13px | dense cells, helper text, captions. Body floor |
| `--text-num-lg` | 15px | metric values in stat tiles |
| `--text-num` | 13px | tabular figures in cells |
| `--text-label-lg` | 12px | uppercase mono section headers |
| `--text-label` | 11px | uppercase mono labels, wide tracking. Label floor |

The 11px label floor applies only to uppercase monospace with wide tracking,
which reads larger than its nominal size.

### Migration mapping

| Current | Goes to |
| --- | --- |
| 8.5px to 12.5px, not mono | `--text-body-sm` |
| 13px, 13.5px | `--text-body-sm` when dense or secondary, `--text-body` when primary |
| 14px, 14.5px | `--text-body` |
| 15px, 15.5px, 17px | `--text-body-lg` |
| 9px to 10.5px uppercase mono | `--text-label` |
| 11px to 12px uppercase mono | `--text-label-lg` |
| 10px to 11.5px mono tabular, not uppercase | `--text-num` |

Current spread, for reference. Body copy: 36 below 12px, 13 at 12px, 54 at
12.5px, 58 at 13px, 28 at 13.5px, 37 at 14px, 4 at 14.5px, 16 at 15px, 3 at
15.5px, 2 at 17px. Uppercase mono labels: 8 at 9px, 40 at 9.5px, 49 at 10px,
24 at 10.5px, 7 at 11px, 2 at 11.5px, 2 at 12px.

---

## 5. The contrast guard is lying

`scripts/check-contrast.mjs` passes today while 213 occurrences sit below
threshold. Three reasons:

1. It only judges a rule that declares **both** a colour and a background in
   the same block. Most kit colour lives in Tailwind utilities, not paired
   declarations.
2. It skips any declaration containing `var(`. After a token migration that
   would be nearly everything.
3. Its `BASE_SURFACE` map assumes one surface per stylesheet. That stops
   being true the moment there are two themes.

The fix: parse both palette blocks into a per-theme substitution table,
resolve tokens and alpha modifiers to rendered colours, measure every pairing
under both themes, and add the type-scale floor check to the same run. Keep
the non-zero exit so `npm test` blocks regressions.

A static analyser still cannot resolve a surface set by a parent element.
Those get reported as **unmeasured**, which is a warning and explicitly not a
pass. An audit that cries wolf gets ignored; an audit that quietly passes
illegible text is worse.

Expect the guard to fail loudly the first time it runs correctly, on
pre-existing debt rather than on new work. That is intended, and it is why the
ramp and scale fixes land with the guard rather than after it.

`scripts/check-ui.mjs` also needs a change: its `INK-TEXT` check bans the
paper tints as text colours on the premise that they are surfaces. That
premise inverts when those tints become dark surfaces.

---

## 6. One controller, not four

Appearance state is currently duplicated across `App.jsx`, `pages/Home.jsx`,
`pages/Admin.jsx` and `components/auth/AuthShell.jsx`. Each reads
`data-theme` on mount and writes it back; three of them dispatch
`ragestar-theme-change` to resynchronise the others. The kit's own screens
keep no appearance state at all.

All four collapse onto one controller owning the attribute, the storage key
and the event. This removes the bug class where a surface reports a theme the
page is not in, because it read the attribute once on mount. It also removes
the duplicated first-paint logic, which matters for the no-flash guarantee:
the stored theme must be applied before the first render, and that can only
be guaranteed from one place.

No screen currently renders a visible toggle. One goes into each persistent
navigation surface: the marketing nav, the dashboard rail, the staff console
rail.

---

## 7. Delivery order

The sequencing is not arbitrary. Each step is verifiable on its own.

| # | Step | Blocked by | Why here |
| --- | --- | --- | --- |
| 1 | Tokenize the 143 literal colours | none | No visual change; makes the swap reachable |
| 2 | Fix the contrast guard | none | Must be honest before it can gate anything |
| 3 | Declare the dark palette | 1 | Pointless before the literals are gone |
| 4 | One controller plus visible toggles | 3 | Needs a palette to switch to |
| 5 | Raise text onto the ink ramp | 2, 3 | Needs the guard to verify and both themes to test |
| 6 | Apply the type scale | 2, 5 | Same files and className strings as step 5 |

Steps 1 and 2 are independent and can run in parallel. Steps 5 and 6 touch
the same className strings in the same 14 files, so run them back to back
rather than concurrently.

Step 1 is wide and mechanical, so it wants a light-theme screenshot pass
before step 3 lands. The whole point of that step is that nothing should look
different afterwards.

---

## 8. Invariants worth keeping

- Exactly two themes. Any other stored value resolves to light.
- Tokens are the only place a colour is defined. No literal hex in
  `src/ragestar/**` JSX, and no `text-[#...]` or `bg-[#...]` either.
- 65% is the ink floor for text. Lower is for non-text only.
- Status meaning is never carried by colour alone. Every coloured state also
  has a text or shape indicator.
- Geometry is theme-independent. Radii, spacing, borders and the type scale
  do not change between themes.
- A storage failure degrades to session-only theme. It never blocks the
  switch.
- Theme changes apply to the mounted screen without a reload and without
  remounting the route.
