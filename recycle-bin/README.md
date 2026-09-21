# recycle-bin

Files moved out of the build, not deleted. Paths are preserved, so restoring
anything is a single move back to the repo root:

```powershell
Move-Item recycle-bin\src\pages\Console.jsx src\pages\Console.jsx
```

Nothing in here is imported by the running app or by any test. That was checked
before moving each file.

## Moved on 2026-09-21

The retired console and landing layers. `#/console` was retired in v12.8 and
now redirects to `#/dashboard/*`; `App.jsx` no longer routes any of this.

| File | Why |
|---|---|
| `src/pages/Console.jsx` | the retired console shell; nothing imports it |
| `src/pages/Workspace.jsx` | the retired workspace shell; nothing imports it |
| `src/pages/Community.jsx` | the old standalone community portal; `#/community` redirects to `#/dashboard/community` and the live panel is `pages/workspace/CommunityPanel.jsx` |
| `src/components/Fabric.jsx` | landing-page diagram; no importers |
| `src/pages/Admin.jsx.broken` | stray 113 KB backup copy |
| `src/pages/console/{OverviewTab,CreditsTab,ModelsTab,StatusTab,PlaygroundTab,LogsTab,ProfileTab,ReferralsTab}.jsx` | tabs of the retired console; only reachable through `Console.jsx` / `Workspace.jsx` |

## Deliberately left in place

Two files in `src/pages/console/` are still live and must NOT be moved here:

- **`parts.jsx`** — imported by `src/pages/admin/GateTab.jsx` (a live admin tab).
- **`KeysTab.jsx`** — imported by `scripts/render/keys-live.mjs` and exercised by
  `npm run test:keys-live`. It is the legacy create-key form, but the test suite
  covers it, so it stays until that test is retired.

`CommunityPanel.jsx` previously lived under `src/pages/workspace/` and is now
reachable from the dashboard as the Community view (`#/dashboard/community`).
Do not confuse it with the `Community.jsx` in this bin.
