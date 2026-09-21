# Bug report — "Rendered more hooks than during the previous render."

Project: `ragestar-react` v11.0.0 (React 18.3.1, Vite 5)
Status: **Fixed** — one file changed, `src/pages/Admin.jsx`

---

## 1. What you saw

The admin panel replaced itself with the app's own crash card:

> **This view hit an unexpected error.**
> Nothing else was lost — the rest of the app is still running.
> `Rendered more hooks than during the previous render.`

That card is `src/components/ErrorBoundary.jsx`. It is working correctly — it
caught a real error thrown during render and kept the rest of the app alive.
The message inside it comes from React itself, not from this codebase.

## 2. What I did

1. Unpacked the archive — 143 files, of which 65 are `.js` / `.jsx` under `src/`.
2. Read every source file in `src/` (all pages, all admin tabs, all console tabs,
   every component, every `lib/` module), plus `package.json`, `vite.config.js`,
   `index.html`, the `supabase/` functions and SQL, `cloudflare/`, `scripts/`,
   `qa/` and the root docs.
3. Wrote an AST-based checker (`@babel/parser`, JSX enabled) that walks every
   function in every file and flags three things:
   - `HOOK_AFTER_EARLY_RETURN` — a hook called after a top-level `return`
   - `CONDITIONAL_HOOK` — a hook inside `if` / ternary / `&&` / loop / `try` / `switch`
   - `HOOK_IN_PLAIN_FN` — a hook in a function that is not a component or hook
   A plain text/regex scan was tried first and produced a pile of false
   positives (it counted `return` inside `useEffect` cleanups, `.map()`
   callbacks and `try/catch` blocks), so its output was discarded.
4. Read the source around every candidate by hand before calling it a bug.

**Result: exactly two violations in the whole project, both in the same place.**

```
[HOOK_AFTER_EARLY_RETURN] pages/Admin.jsx:776 - useMemo() runs after the early return on line 744 inside Admin()
[HOOK_AFTER_EARLY_RETURN] pages/Admin.jsx:777 - useMemo() runs after the early return on line 744 inside Admin()
```

### Suspects that were checked and cleared

| File | Why it looked suspicious | Verdict |
|---|---|---|
| `components/KeyWatch.jsx` | 20 hook calls, a `return null` at line 51 | The return is inside a `try/catch` in a `useCallback` body. All 14 hooks are top-level. Safe. |
| `components/ui/CommandPalette.jsx` | 23 hook calls, `useState` at line 303 | Both that `useState` and the following `useHotkeys` are top-level. The flagged returns were inside `useMemo`/`useCallback` bodies. Safe. |
| `components/ui/Tree.jsx` | `useFolders` appeared to be nested in `Explorer()` | It is a separate top-level `export function`. Safe. |
| `pages/Console.jsx` | `if (loading) return` at line 306 | All 26 hooks run before it. Safe — and this is the pattern `Admin.jsx` should have followed. |
| `lib/ux.js` | 47 hook calls, the densest file in the project | Every exported hook calls its hooks unconditionally at the top. Safe. |
| `pages/admin/parts.jsx` (`useFilters`) | Custom hook used by `Admin.jsx` | `useMemo` / `useState` / `useEffect` / `useCallback` all unconditional. Safe. |

## 3. The problem, precisely

`src/pages/Admin.jsx` — component `Admin()`, declared on line 229.

It opens with roughly 25 hook calls (`useState`, `useSession`, two `useFilters`,
a `useCallback` for `loadAll`, a `useEffect` that calls it). Then:

```jsx
// line 744 — the early return
if (loading) {
  return (
    <main id="main" className="container section gate-wait">
      <Spinner size={22} />
      <p className="muted small mt-4">Loading admin panel…</p>
    </main>
  );
}

// …30 lines of plain derived values…

// lines 776-777 — TWO MORE HOOKS, below the return
const shownLogs  = useMemo(() => filterLogs(logs, logFilter),    [logs, logFilter]);
const shownAudit = useMemo(() => filterAudit(audit, auditFilter), [audit, auditFilter]);
```

`loading` starts as `true`, and `loadAll()` flips it to `false` in its `finally`
block once Supabase answers. So:

| Render | `loading` | Hooks React records |
|---|---|---|
| 1st (mount) | `true` | stops at the `return` on line 744 → **N hooks** |
| 2nd (data arrived) | `false` | falls through to lines 776-777 → **N + 2 hooks** |

React stores hook state as an ordered linked list per component and matches it
up by call order, not by name. When render 2 asks for two hooks that render 1
never registered, React cannot line the lists up, so it aborts the render and
throws `Rendered more hooks than during the previous render.` The nearest
`ErrorBoundary` catches the throw and shows the crash card.

This is a violation of the **Rules of Hooks**: hooks must be called in the same
order, the same number of times, on every render — never after a conditional
return, and never inside `if` / loops / `try`.

### Why it survived in the codebase

- `#/admin` is behind `RequireAuth` with `GUARDED["#/admin"] = true`, so it only
  renders for an admin session.
- The crash needs a *second* render — you only see it once the data lands, which
  is about a second after arriving on the page. On a fast cache it can look like
  the panel "flashed and died".
- `pages/Console.jsx` has the identical `if (loading) return` shape but keeps all
  its hooks above it, which is why the console never broke.

## 4. The fix

One change, `src/pages/Admin.jsx`: the two `useMemo` calls were moved up to sit
with the rest of the hooks, immediately after the `useEffect` that kicks off
`loadAll()` — i.e. **above** the `if (loading)` return. Nothing else changed.

```jsx
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  /* Derived rows for the logs and audit tables. …above any early return. */
  const shownLogs  = useMemo(() => filterLogs(logs, logFilter),     [logs, logFilter]);
  const shownAudit = useMemo(() => filterAudit(audit, auditFilter), [audit, auditFilter]);
```

Why this is safe:

- Both `useMemo` calls read only `logs`, `audit`, `logFilter`, `auditFilter`
  (state and `useFilters` results declared on lines 243-270) and the two
  module-level helpers `filterLogs` / `filterAudit` (lines 212-228). Every
  identifier is already in scope at the new location.
- While `loading` is `true`, `logs` and `audit` are `[]`, so both memos compute
  an empty array — cheap, and thrown away by the early return anyway.
- `shownLogs` / `shownAudit` are only *read* inside the logs and audit tabs
  (lines ~1839-1932), far below the new declaration site.
- `useMemo` was already imported on line 1.

Alternative fixes that were rejected: deleting the memoisation (loses the
caching on tables that can hold hundreds of rows), or splitting the logs/audit
tabs into their own child components (correct, but a much larger refactor than
this bug warrants).

## 5. Verification

| Check | Before | After |
|---|---|---|
| AST hook-order violations across 65 files | 2 | **0** |
| Files parsed without syntax error | 65/65 | 65/65 |
| Identifiers used by the moved code in scope at new site | n/a | yes (verified line by line) |
| `useMemo` imported | yes | yes |

## 6. Guard against a repeat

Add the official lint rule so this is caught at authoring time rather than at
runtime:

```bash
npm i -D eslint eslint-plugin-react-hooks
```

```js
// eslint.config.js
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
```

`rules-of-hooks` flags exactly this mistake — a hook below a conditional return —
as an error, on the line it happens.

House rule worth keeping: in any component, **every hook goes in one block at
the top; the first `return` is the last thing before JSX.** `pages/Console.jsx`
is the reference to copy.
