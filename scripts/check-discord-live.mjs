#!/usr/bin/env node
/* Runs discord-live.mjs in a subprocess with the render module hooks, and
   skips cleanly when the ad-hoc dependencies are not installed. */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { join } from "node:path"
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
  console.log(paint.bold("discord-live"))
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

/* The screen's data layer is doubled so the gate flag, the linked identity and
   the community-server verdict can each be set exactly (see the stubs). */
const mapFile = join(ROOT, "scripts", "render", ".discord-double.json")
writeFileSync(
  mapFile,
  JSON.stringify({
    "src/ragestar/lib/workspace.js": "scripts/render/stubs/workspace-live.js",
    "src/lib/db.js": "scripts/render/stubs/db-live.js",
    "src/lib/discord.js": "scripts/render/stubs/discord-live.js",
  }),
)

const register = pathToFileURL(join(ROOT, "scripts/render/register.mjs")).href
const entry = join(ROOT, "scripts/render/discord-live.mjs")

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
