#!/usr/bin/env node
/* ==========================================================================
   check-admin-live — decides whether this machine can run the live admin
   test, then hands off to scripts/render/admin-live.mjs
   --------------------------------------------------------------------------
   Needs react, react-dom/client, a JSX transform (Vite's esbuild) and jsdom.
   jsdom is deliberately not a project dependency — install it ad hoc with
   `npm i --no-save jsdom` when you want the live check. When anything is
   missing this prints SKIP and exits 0, exactly like check-render: a test
   that cannot run is not a test that failed.
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
  console.log(paint.bold("admin-live"))
  console.log()
  console.log(`${paint.amber(" skip")}  ${why}`)
  console.log(
    paint.dim(
      "        the static hook-order audit (`npm run test:hooks`) still runs and still\n" +
        "        covers the class of bug this test reproduces dynamically.",
    ),
  )
  console.log()
  process.exit(0)
}

if (!has("react") || !has("react-dom/client")) {
  skip("react / react-dom are not installed here — run `npm install` first")
}
if (!has("vite") && !has("esbuild") && !has("tsx")) {
  skip("no JSX transform available — install dev dependencies (vite)")
}
if (!has("jsdom")) {
  skip("jsdom is not installed — `npm i --no-save jsdom` to enable the live check")
}

const register = pathToFileURL(join(ROOT, "scripts/render/register.mjs")).href
const entry = join(ROOT, "scripts/render/admin-live.mjs")

const run = spawnSync(process.execPath, ["--import", register, entry], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    RENDER_ROOT: ROOT,
    RENDER_TRANSFORM: "esbuild",
  },
})

process.exit(run.status ?? 1)
