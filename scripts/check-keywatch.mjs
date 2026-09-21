#!/usr/bin/env node
/* ==========================================================================
   check-keywatch — proves the key-watch system is still wired up
   --------------------------------------------------------------------------
   Run from the project root:

       npm run test:keywatch

   This is the offline half of the key-watch story. It reads files only: no
   network, no Supabase, no secrets. It answers one question —
   "is the plumbing still correct in this repository?" — and it exists because
   the v11.0 outage was a *configuration* bug that every runtime check
   reported as healthy:

       config.toml had no [functions.keywatch] block, so verify_jwt defaulted
       to true, so Supabase answered the cron worker with 401 before the
       function ran, so keywatch_last_run_at was never stamped, so the admin
       card said "last pass never" — while wrangler deploy exited 0 and the
       Cloudflare dashboard showed a perfectly healthy cron.

   Nothing here can tell you whether your deployed function is reachable. For
   that run the live doctor, which does hit the network:

       npm run keywatch:doctor

   Exit 0 = the repository is wired correctly. 1 = a regression, printed with
   the fix.
   ========================================================================== */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = process.cwd()

const tty = process.stdout.isTTY
const paint = tty
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s }

const failures = []

function line(ok, label, detail) {
  console.log(`${ok ? paint.green("  ok ") : paint.red(" fail")}  ${label}${detail ? paint.dim(` \u2014 ${detail}`) : ""}`)
}

function check(label, ok, detail, fix) {
  line(ok, label, detail)
  if (!ok) failures.push({ label, detail, fix })
}

function read(rel) {
  const path = resolve(ROOT, rel)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

function has(rel) {
  return existsSync(resolve(ROOT, rel))
}

console.log(paint.bold("check-keywatch") + paint.dim("  repository wiring, no network"))
console.log()

/* ------------------------------------------------------- 1. the files exist */

const REQUIRED = [
  ["supabase/functions/keywatch/index.ts", "the edge function the cron calls"],
  ["supabase/upgrade-v11.3-keywatch-in-postgres.sql", "the pg_cron schedule that calls it"],
  ["supabase/upgrade-v11.3b-selftest-pg-cron.sql", "the pg_cron-aware selftest"],
  ["scripts/keywatch-doctor.mjs", "the live doctor"],
  ["src/components/KeyWatch.jsx", "the admin card"],
]

for (const [file, why] of REQUIRED) {
  check(`file ${file}`, has(file), why, `restore ${file} from the v11.3 archive`)
}

/* --------------------------------------------- 2. THE BUG: verify_jwt=false */

const config = read("supabase/config.toml")
const block = config ? config.split(/^\[/m).find((s) => s.startsWith("functions.keywatch]")) : null
const verifyOff = block ? /^\s*verify_jwt\s*=\s*false\s*$/m.test(block) : false

check(
  "config.toml has [functions.keywatch]",
  Boolean(block),
  block ? "present" : "MISSING — this is the original 401 bug",
  'add a [functions.keywatch] block to supabase/config.toml with verify_jwt = false',
)
check(
  "keywatch runs with verify_jwt = false",
  verifyOff,
  verifyOff ? "the scheduled call can reach the function" : "Supabase will 401 the scheduled call before the function runs",
  'set verify_jwt = false under [functions.keywatch], then: supabase functions deploy keywatch --no-verify-jwt',
)

/* ------------------------------------------- 3. deploy scripts carry the flag */

const pkgRaw = read("package.json")
let pkg = null
try {
  pkg = pkgRaw ? JSON.parse(pkgRaw) : null
} catch {
  pkg = null
}
const scripts = pkg?.scripts ?? {}

check("package.json parses", Boolean(pkg), pkg ? `version ${pkg.version}` : "invalid JSON", "fix package.json")

const deployCmds = Object.entries(scripts).filter(([, cmd]) => /functions\s+deploy[^&|]*\bkeywatch\b/.test(cmd))
check(
  "a script deploys the keywatch function",
  deployCmds.length > 0,
  deployCmds.map(([n]) => n).join(", ") || "none found",
  'add: "fn:keywatch": "supabase functions deploy keywatch --no-verify-jwt"',
)

const flagged = deployCmds.filter(([, cmd]) => cmd.includes("--no-verify-jwt"))
check(
  "every keywatch deploy passes --no-verify-jwt",
  deployCmds.length > 0 && flagged.length === deployCmds.length,
  deployCmds.length
    ? `${flagged.length}/${deployCmds.length} carry the flag`
    : "no deploy script to check",
  "append --no-verify-jwt to the keywatch deploy command, so it works even if config.toml is not pushed",
)

check(
  "the live doctor is runnable",
  typeof scripts["keywatch:doctor"] === "string",
  scripts["keywatch:doctor"] || "missing",
  'add: "keywatch:doctor": "node scripts/keywatch-doctor.mjs"',
)

/* ---------------------------------------------------- 4. the migrations ship */

const sql = has("supabase") ? readdirSync(resolve(ROOT, "supabase")).filter((f) => f.endsWith(".sql")) : []
const v110 = sql.find((f) => /v11\.0/.test(f))
const v111 = sql.find((f) => /v11\.1/.test(f))
check("v11.0 keywatch migration present", Boolean(v110), v110 || "missing", "restore supabase/upgrade-v11.0-*.sql")
check("v11.1 repair migration present", Boolean(v111), v111 || "missing", "restore supabase/upgrade-v11.1-*.sql")

/* v6.0 mislabelled scheduled passes as 'traffic'. The repair must keep the
   caller's source, so a cron pass reads as a cron pass in the audit trail. */
const repair = v111 ? read(`supabase/${v111}`) : null
check(
  "scheduled passes keep the 'cron' source",
  Boolean(repair && /\bcron\b/.test(repair)),
  repair ? "the repair migration mentions the cron source" : "cannot verify",
  "re-apply supabase/upgrade-v11.1-keywatch-repair.sql",
)

/* ------------------------------------------------- 5. the shared secret gate */

const fn = read("supabase/functions/keywatch/index.ts")
check(
  "the function gates on x-keywatch-secret",
  Boolean(fn && /x-keywatch-secret/i.test(fn)),
  fn ? "header check present" : "function missing",
  "the function must compare x-keywatch-secret against KEYWATCH_CRON_SECRET itself",
)

/* v11.3: the scheduler is a row in cron.job created by keywatch_schedule(), so
   "is the worker deployed with a cron trigger" becomes "does the migration
   still install the schedule, and does it still send the secret header". */
const sched = read("supabase/upgrade-v11.3-keywatch-in-postgres.sql")
check(
  "the schedule sends x-keywatch-secret",
  Boolean(sched && /x-keywatch-secret/i.test(sched)),
  sched ? "header sent by pg_net" : "migration missing",
  "keywatch_schedule() must send the shared secret; pg_net has no Supabase JWT and must never be given one",
)
check(
  "the schedule installs a cron entry",
  Boolean(sched && /cron\.schedule/.test(sched) && /ragestar-keywatch/.test(sched)),
  sched ? "cron.schedule('ragestar-keywatch', ...)" : "migration missing",
  "keywatch_schedule() must call cron.schedule('ragestar-keywatch', ...)",
)

/* THE v11.3 TRAP, and the reason this check exists at all. The 15 s beat comes
   from the function's spaced passes, not from cron. Every one of those passes
   must be granted by internal_keywatch_due(), which refuses anything sooner
   than keywatch_interval_seconds. Leave the floor at 60 and passes 2-4 are
   silently refused: the function still succeeds, the card still shows a fresh
   pass, and the keys are checked once a minute instead of four times. */
const selftest = read("supabase/upgrade-v11.3b-selftest-pg-cron.sql")
check(
  "the interval floor still allows a 15 s beat",
  Boolean(selftest && /keywatch_interval_seconds\s*=\s*15/.test(selftest)),
  selftest ? "the 60 s clamp is reverted" : "selftest migration missing",
  "re-apply supabase/upgrade-v11.3b-selftest-pg-cron.sql — a 60 s floor refuses passes 2-4 without saying so",
)

/* ------------------------------------------------ 6. the card is still wired */

const card = read("src/components/KeyWatch.jsx")
const adminPage = read("src/pages/Admin.jsx")
const dashTab = read("src/pages/admin/DashboardTab.jsx")

check(
  "the card reads live status from the database",
  Boolean(card && /getKeywatchStatus/.test(card)),
  card ? "getKeywatchStatus imported" : "card missing",
  "KeyWatch.jsx must call getKeywatchStatus from src/lib/db.js",
)
check(
  "the card is mounted in the admin panel",
  Boolean((adminPage && /<KeyWatch/.test(adminPage)) || (dashTab && /<KeyWatch/.test(dashTab))),
  [adminPage && /<KeyWatch/.test(adminPage) ? "Admin.jsx" : null, dashTab && /<KeyWatch/.test(dashTab) ? "DashboardTab.jsx" : null]
    .filter(Boolean)
    .join(" + ") || "nowhere",
  "render <KeyWatch onRun={autoTest} defaultSeconds={15} /> in the admin panel",
)

const db = read("src/lib/db.js")
for (const fnName of ["getKeywatchStatus", "saveKeywatchSettings", "pingKeywatchFn"]) {
  check(
    `db.js exports ${fnName}`,
    Boolean(db && new RegExp(`export\\s+(async\\s+)?function\\s+${fnName}\\b`).test(db)),
    db ? "" : "src/lib/db.js missing",
    `restore ${fnName} in src/lib/db.js`,
  )
}

/* ------------------------------------------------------------------ verdict */

console.log()

if (failures.length) {
  console.log(paint.red(paint.bold(`${failures.length} problem(s) in the key-watch wiring:`)))
  for (const f of failures) {
    console.log(`  ${paint.bold(f.label)}${f.detail ? ` — ${f.detail}` : ""}`)
    console.log(`     ${paint.bold("fix:")} ${f.fix}`)
  }
  console.log()
  process.exit(1)
}

console.log(paint.green(paint.bold("key-watch wiring is intact")))
console.log(paint.dim("  this checks the repository only — run `npm run keywatch:doctor` to test the deployment"))
process.exit(0)
