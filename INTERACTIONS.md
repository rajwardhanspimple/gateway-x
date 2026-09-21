# Interaction layer (v10)

What was added to make the app feel responsive to every input, and where it
lives. All of it is additive — no existing component was replaced.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | command palette — jump to any route or console tab (works from inside text fields too) |
| `/` | focus the nearest search field, or open the palette if there is none |
| `?` | shortcut sheet |
| `⌘⇧L` / `Ctrl+Shift+L` | toggle light / dark |
| `g` then `h` | home |
| `g` then `c` | console |
| `g` then `a` | admin (falls back to console for non-admins) |
| `Esc` | close the palette, sheet or dialog |

Shortcuts are suppressed while typing in an input, except `⌘K`, which is meant
to work from anywhere. The palette remembers your last four destinations and
ranks matches with a fuzzy score, so `cns` finds *Console*.

## Feedback

- **Toasts** — `toast.ok()`, `toast.error()`, `toast.info()`, `toast.loading()`
  with an optional action button, a progress bar, hover-to-pause and a
  screen-reader announcement. Stacked bottom-right, dismissible.
- **Connection toasts** — going offline or coming back online says so instead
  of failing a request silently.
- **Route announcements** — an ARIA live region names each new route for screen
  readers, since a hash change is not a page load.
- **Scroll progress** — a thin bar tracks reading position on long pages, and
  is hidden on auth routes.

## Components (`src/components/ui/interactions.jsx`)

| Component | Behaviour |
| --- | --- |
| `CopyButton` / `CopyField` | one-click copy with a tick confirmation and a toast; falls back to `execCommand` on old browsers |
| `ConfirmButton` | arms on first click, confirms on second, disarms after 3s — no modal for destructive-but-small actions |
| `Switch` | real checkbox underneath, so it is keyboard and screen-reader correct |
| `Tooltip` | opens on hover *and* focus, closes on `Esc`, flips side when it would clip |
| `IconButton` | four tones, three sizes, always has an accessible name |
| `Skeleton` / `SkeletonRows` | shimmer placeholders sized like the content they replace |
| `EmptyState` | icon, explanation and the one action that fixes it |
| `ScrollTop` | appears after a screenful, respects reduced motion |
| `Kbd` | renders `⌘` on macOS and `Ctrl` elsewhere |

## Hooks (`src/lib/ux.js`)

`useToasts`, `useAnnouncer`, `useCopy`, `useHotkeys`, `useAsyncAction`,
`useArmed`, `useLocalState`, `useDebounced`, `useMediaQuery`,
`useScrollProgress`, `useConnectionToasts`, `useFocusTrap`, `fuzzyScore`.

`useAsyncAction` is the one worth knowing: it wraps an async handler so a button
cannot be double-submitted, exposes `busy`, and routes failures to a toast.

## Accessibility and comfort

- Visible focus rings on every interactive element, via `:focus-visible`.
- 44px minimum touch targets on coarse pointers.
- Dialogs trap focus, lock background scroll and restore focus on close.
- `prefers-reduced-motion` removes transitions and animations rather than
  shortening them.
- `forced-colors` mode keeps borders and focus rings visible.
- Styles live in `src/styles/interactions.css`, loaded last in `src/main.jsx`,
  and use the existing `flim.css` design tokens — light and dark both work
  without new colour definitions.
