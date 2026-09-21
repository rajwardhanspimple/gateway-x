#!/usr/bin/env node
/* Runs keys-view-live.mjs in a subprocess with the render module hooks, and
   skips cleanly when the ad-hoc dependencies are not installed. */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { join, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import { writeFileSync, rmSync } from "node:fs"

const ROOT = process.cwd()
const require = createRequire(pathToFileURL(join(ROOT, "package.json")).href)

const paint = process.stdout.isTTY
  ? { bold: (s) => `\u001b[1m${s}\u001b[0m`, amber: (s) => `\u001b[33m${s}\u001b[0m` }
  : { bold: (s) => s, amber: (s) => s }

const has = (spec) => {
  try {
    require.resolve(spec)
    return true
  } catch {
    return false
  }
}

function skip(why) {
  console.log(paint.bold("keys-view-live"))
  console.log()
  console.log(`${paint.amber(" skip")}  ${why}`)
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

/* Point the loader at the workspace double so the harness can drive the
   screen's data layer instead of the opaque Supabase stub. */
const mapFile = join(ROOT, "scripts", "render", ".workspace-double.json")
writeFileSync(
  mapFile,
  JSON.stringify({ "src/ragestar/lib/workspace.js": "scripts/render/stubs/workspace-live.js" }),
)

const register = pathToFileURL(join(ROOT, "scripts/render/register.mjs")).href
const entry = join(ROOT, "scripts/render/keys-view-live.mjs")

const run = spawnSync(process.execPath, ["--import", register, entry], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    RENDER_ROOT: ROOT,
    RENDER_TRANSFORM: "esbuild",
    RENDER_STUB_MAP: mapFile,
  },
})

rmSync(mapFile, { force: true })
process.exit(run.status ?? 1)
