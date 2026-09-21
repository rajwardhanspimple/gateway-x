#!/usr/bin/env node
/* skip-cleanly if any runtime is missing */
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
  console.log(paint.bold("keys-live"))
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

const register = pathToFileURL(join(ROOT, "scripts/render/register.mjs")).href
const entry = join(ROOT, "scripts/render/keys-live.mjs")

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