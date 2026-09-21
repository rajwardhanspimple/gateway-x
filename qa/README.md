# Visual QA harness

Static mirrors of the **v9 “grid paper”** landing, linked against the real
stylesheets in `../src/styles` in the same order `src/main.jsx` imports them.
They exist because the design sandbox has no network, so Vite cannot run; this
lets the folds be rendered and inspected as images.

| file | palette |
| --- | --- |
| `landing-v9.html` | paper (default, `data-theme="light"`) |
| `landing-v9-ink.html` | ink (`data-theme="dark"` — plum canvas, citron display type) |

The inline block at the top of each file disables animation so captures are
deterministic.

    python3 capture_html.py qa/landing-v9.html     out/desk-paper.png --width 1440 --height 900 --full-page
    python3 capture_html.py qa/landing-v9-ink.html out/desk-ink.png   --width 1440 --height 900 --full-page
    python3 capture_html.py qa/landing-v9.html     out/mob-paper.png  --width 390  --height 844 --full-page

The harness is a QA artefact, not part of the app bundle — Vite only builds
from `index.html`. The v8 mirrors (`landing.html`, `landing-v8.html` and their
light variants) were deleted along with `src/styles/landing-v8.css`: that look
is gone, so keeping a harness for it would only invite regressions.

## Admin → Token compressors

`admin-compressors-v9.html` mirrors the new admin tab: the rail with **Token
compressors** selected, the stat row, the compressor table with an open trace,
the preset row, the editor (stage grid, lossy badges, live preview) and the
bench. It exists because the tab is the densest screen in the app and the
React version cannot be rendered here — there is no `node_modules` in this
sandbox, so nothing can be built.

```
python3 /data/skills/artifact-design/scripts/capture_html.py \
  qa/admin-compressors-v9.html /data/out/admin-compressors.png \
  --width 1440 --height 1000 --full-page
```

Three defects were found and fixed this way, all of them invisible in source
review: `.adm-stat` ran the number into its caption (`42 enabled`), the
`.cmp-*` rules were missing entirely so the stage grid collapsed into running
text, and `minimal.css` paints every `<pre>` with `!important`, which put a
white slab inside the dark “forwarded messages” block.

Keep the mirror's class names in step with `src/pages/admin/CompressorTab.jsx`.
If they drift, the capture will keep passing while the real tab breaks.

## Console → tab strip + Playground

`console-v10.html` / `console-v10-ink.html` mirror the console with the
**Playground** tab selected: the nine-tab strip with its counts, the panel
heading, the request composer, the response panel, and — under a `QA only`
label — the `sending` and `idle` states of that panel, which are otherwise
unreachable in a static mirror.

```
python3 /data/skills/artifact-design/scripts/capture_html.py \
  qa/console-v10.html /data/out/v10-paper.png --width 1440 --height 900 --full-page
python3 /data/skills/artifact-design/scripts/capture_html.py \
  qa/console-v10-ink.html /data/out/v10-ink.png --width 1440 --height 900
python3 /data/skills/artifact-design/scripts/capture_html.py \
  qa/console-v10.html /data/out/v10-mobile.png --width 390 --height 844 --full-page
```

The stylesheet order in the `<head>` is the point of this mirror. `main.jsx`
imports `App.jsx` before its own sheets, so the four sheets App pulls in —
including `console-tabs.css` — land *before* `styles.css … flim.css`. The
capture reproduced the bug exactly: `flim.css` sets `.con-tab { width: 100% }`
for the admin's vertical rail, that won the cascade over the horizontal strip,
and every tab but the first scrolled out of the hidden-scrollbar track. Only
`+` and `OVERVIEW` were left on screen. `console-v10.css` loads last and pins
the strip's own geometry.

The grid also caught a second defect that source review missed: the response
metadata grid used `repeat(auto-fit, minmax(104px, 1fr))` over a 1px grey gap,
which looked right at six cells and left a bare grey slab beside the last cell
at five — the normal case when the gateway omits a header. It is now three
fixed columns with the hairlines on the cells.

Keep the mirror in step with `src/pages/Console.jsx` and
`src/pages/console/PlaygroundTab.jsx`; if the class names drift the capture
will keep passing while the real tab breaks.

---

## dashboard-snow.html / dashboard-snow-ink.html

Static mirrors of the unified dashboard (`#/dashboard`, `src/pages/Workspace.jsx`
with `src/pages/console/OverviewTab.jsx` in the canvas) used to review
`src/styles/dashboard-snow.css`, the light admin-console reskin of the rail
shell. The `-ink` file is the same markup with `data-theme="dark"`.

Both link the real stylesheets in exactly the order `App.jsx` + `main.jsx` load
them, ending with `dashboard-snow.css`, so specificity and cascade match the
running app. Class names must be kept in step with the JSX.

Captured with:

```
python capture_html.py qa/dashboard-snow.html out.png --width 1440 --height 950 --full-page
python capture_html.py qa/dashboard-snow-ink.html out.png --width 1440 --height 950 --full-page
python capture_html.py qa/dashboard-snow.html out.png --width 390 --height 844 --full-page
```

What the review caught, and what the sheet now undoes at the end of the
cascade: `flim.css` welds `.adm-stats` into one hairline strip, `console-v11.css`
gives the tiles mono micro-labels plus a rule above the caption and an accent
bar on flagged tiles, `console-v11.css` sets card titles in mono all-caps, and
`minimal.css` paints the `.st-*` status tints with `!important`.
