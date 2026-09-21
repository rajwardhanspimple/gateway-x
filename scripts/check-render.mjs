#!/usr/bin/env node
/* ==========================================================================
   check-render — decides whether this machine can render React outside a
   browser, then hands off to scripts/render/render.mjs
   --------------------------------------------------------------------------
   Needs three things: react, react-dom/server, and something that can turn
   JSX into JavaScript. The last one is either `tsx` or the esbuild that Vite
   already depends on — whichever is installed.

   If none of that is present it prints SKIP and exits 0. A test that cannot
   run is not a test that failed, and `npm test` must never punish someone
   for a missing optional dev dependency.
   ========================================================================== */

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const ROOT = process.cwd()
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href)

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, amber: (s) => s }

const has = (spec) => {
  try {
    require.resolve(spec)
    return true
  } catch {
    return false
  }
}

function skip(why) {
  console.log(paint.bold("check-render"))
  console.log()
  console.log(`${paint.amber(" skip")}  ${why}`)
  console.log(
    paint.dim(
      "        the static checks in `npm run test:ui` still ran and still cover parsing,\n" +
        "        hooks, imports, classes and the dashboard contract.",
    ),
  )
  console.log()
  process.exit(0)
}

if (!has("react") || !has("react-dom/server")) {
  skip("react / react-dom are not installed here — run `npm install` first")
}

/* tsx transforms JSX on import by itself. Otherwise borrow Vite's esbuild. */
let transform = null
if (has("tsx")) transform = "tsx"
else if (has("vite") || has("esbuild")) transform = "esbuild"

if (!transform) {
  skip("no JSX transform available — install dev dependencies (vite) or `npm i -D tsx`")
}

const register = pathToFileURL(join(ROOT, "scripts/render/register.mjs")).href
const entry = join(ROOT, "scripts/render/render.mjs")

const args =
  transform === "tsx"
    ? ["--import", "tsx", "--import", register, entry]
    : ["--import", register, entry]

const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    RENDER_ROOT: ROOT,
    RENDER_TRANSFORM: transform === "tsx" ? "none" : "esbuild",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
  },
})

process.exit(run.status ?? 1)
