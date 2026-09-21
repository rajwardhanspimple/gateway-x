/* ==========================================================================
   Render test — mounts the two rebuilt tabs for real
   --------------------------------------------------------------------------
   The static checks prove the files parse, the hooks are legal, the imports
   resolve and the classes exist. None of that catches the failure that
   actually reaches a user: a component that throws while rendering because
   a field is missing, a list is undefined, or a helper got the wrong shape.

   So this renders both tabs with react-dom/server against two data sets:

     · populated — the shape the real queries return
     · empty     — null summary, no rows, no handlers at all

   The empty pass matters most. A fresh account has no keys, no logs and no
   traffic, and "works once there is data" is exactly the bug that greets a
   first-time user.

   Run through `npm run test:render`, which decides whether the sandbox can
   do this at all and skips cleanly if not.
   ========================================================================== */

import "./globals.mjs"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, amber: (s) => s }

/* ------------------------------------------------------------- fixtures */

const now = Date.now()
const iso = (msAgo) => new Date(now - msAgo).toISOString()
const HOUR = 3600_000
const DAY = 24 * HOUR

const MODELS = ["gpt-4o-mini", "gpt-4o", "claude-3-5-sonnet", "llama-3.1-70b", "mixtral-8x7b"]

/* 60 calls spread across the last 14 hours, with a believable failure rate
   and a couple of slow outliers so the p95 figure has something to find. */
const logs = Array.from({ length: 60 }, (_, i) => {
  const broken = i % 9 === 0
  return {
    id: `log-${i}`,
    created_at: iso(Math.round((i / 60) * 14 * HOUR)),
    model_public_id: MODELS[i % MODELS.length],
    ok: !broken,
    status_code: broken ? (i % 18 === 0 ? 429 : 502) : 200,
    error_code: broken ? (i % 18 === 0 ? "rate_limited" : "upstream_unavailable") : null,
    latency_ms: i % 17 === 0 ? 6200 : 300 + ((i * 37) % 900),
    failover_count: broken ? 1 : 0,
    tokens_in: 400 + i * 7,
    tokens_out: 120 + i * 3,
    cost_usd: 0.0021 * (i + 1),
  }
})

const upstreams = [
  { id: "up-1", name: "OpenAI", is_active: true },
  { id: "up-2", name: "Anthropic", is_active: true },
  { id: "up-3", name: "Groq", is_active: false },
]

const upKeys = [
  { id: "k-1", upstream_id: "up-1", status: "working", is_active: true, last_checked_at: iso(4 * 60_000) },
  { id: "k-2", upstream_id: "up-1", status: "working", is_active: true, last_checked_at: iso(30 * 60_000) },
  { id: "k-3", upstream_id: "up-1", status: "rate_limited", is_active: true, last_checked_at: iso(3 * HOUR) },
  { id: "k-4", upstream_id: "up-2", status: "working", is_active: true, last_checked_at: iso(9 * HOUR) },
  { id: "k-5", upstream_id: "up-2", status: "failing", is_active: true, last_checked_at: iso(2 * DAY) },
  { id: "k-6", upstream_id: "up-2", status: "expired", is_active: true, last_checked_at: null },
  { id: "k-7", upstream_id: "up-3", status: "unknown", is_active: true, last_checked_at: null },
  { id: "k-8", upstream_id: "up-3", status: "disabled", is_active: false, last_checked_at: iso(5 * DAY) },
  { id: "k-9", upstream_id: "up-9-missing", status: "working", is_active: true, last_checked_at: iso(90 * 60_000) },
]

const series = Array.from({ length: 30 }, (_, i) => {
  const quiet = i < 4
  const requests = quiet ? 0 : 40 + ((i * 53) % 260)
  return {
    day: new Date(now - (29 - i) * DAY).toISOString().slice(0, 10),
    requests,
    failed: i % 7 === 0 ? Math.round(requests * 0.14) : i % 3 === 0 ? 2 : 0,
  }
})

const dashboardProps = {
  full: {
    dash: {
      requests_24h: 18432,
      errors_24h: 143,
      cost_24h: 4.82,
      cost_30d: 121.64,
      avg_latency_24h: 812,
      keys_total: 9,
      keys_working: 4,
      users: 37,
      models: 14,
      upstreams_active: 2,
    },
    upstreams,
    upKeys,
    models: Array.from({ length: 14 }, (_, i) => ({ id: `m-${i}`, public_id: MODELS[i % MODELS.length] })),
    users: Array.from({ length: 37 }, (_, i) => ({ id: `u-${i}` })),
    logs,
    audit: [
      { id: "a-1", actor_email: "owner@example.com", created_at: iso(12 * 60_000) },
      { id: "a-2", actor_email: null, created_at: iso(5 * HOUR) },
    ],
    busy: "",
    onRefresh: () => {},
    onTest: () => {},
    onAutoTest: async () => ({ checked: 0, ok: 0 }),
    onJump: () => {},
  },
  /* A brand new install: the view returns nothing and the page is mounted
     before any handler has been wired up. */
  empty: {
    dash: null,
    upstreams: [],
    upKeys: [],
    models: [],
    users: [],
    logs: [],
    audit: [],
    busy: "",
  },
}

const overviewProps = {
  full: {
    summary: {
      requests: 4120,
      ok: 4061,
      failed: 59,
      tokens_in: 812_344,
      tokens_out: 442_110,
      cost_usd: 38.22,
      avg_latency_ms: 734,
      last_request_at: iso(3 * 60_000),
    },
    series,
    keys: [
      { id: "rr-1", status: "active" },
      { id: "rr-2", status: "revoked" },
    ],
    logs: logs.slice(0, 12),
    models: Array.from({ length: 14 }, (_, i) => ({ id: `m-${i}` })),
    gatewayUrl: "https://render-test.example.com/v1",
    onRefresh: () => {},
    onGo: () => {},
  },
  empty: {
    summary: null,
    series: [],
    keys: [],
    logs: [],
    models: [],
    gatewayUrl: "",
  },
}

/* ---------------------------------------------------------------- cases */

const cases = [
  {
    name: "admin Dashboard · populated",
    module: "../../src/pages/admin/DashboardTab.jsx",
    props: dashboardProps.full,
    expect: [
      "Requests 24h",
      "Key health by provider",
      "Requests by hour",
      "Key check coverage",
      "Recent admin activity",
      "Last failures",
      "Busiest models",
      "OpenAI",
      "kw-", // the key watch card is mounted
    ],
  },
  {
    name: "admin Dashboard · empty install",
    module: "../../src/pages/admin/DashboardTab.jsx",
    props: dashboardProps.empty,
    expect: [
      "Requests 24h",
      "No active keys to check.",
      "Admin actions appear here automatically.",
      "No providers yet",
      "kw-",
    ],
  },
  {
    name: "console Overview · populated",
    module: "../../src/pages/console/OverviewTab.jsx",
    props: overviewProps.full,
    expect: [
      "Overview",
      "Success rate",
      "Your endpoint",
      "Latest requests",
      "Quick actions",
      "https://render-test.example.com/v1",
      "adm-stats",
    ],
  },
  {
    name: "console Overview · empty account",
    module: "../../src/pages/console/OverviewTab.jsx",
    props: overviewProps.empty,
    expect: [
      "You have no active API key yet",
      "No traffic in this window",
      "No requests logged yet",
      "set VITE_GATEWAY_URL",
    ],
  },
]

/* The removed layer must not reappear in the output of either tab. */
const FORBIDDEN = ["vt-rail", "vt-top", "vt-canvas", "vt-shell", ["va", "ulto"].join("")]

/* ------------------------------------------------------------------ run */

const failures = []
const notices = []

const realError = console.error
const realWarn = console.warn
let captured = []
console.error = (...args) => captured.push(args.map(String).join(" "))
console.warn = (...args) => captured.push(args.map(String).join(" "))

const lines = []
lines.push(paint.bold("check-render"))
lines.push("")

for (const c of cases) {
  captured = []
  let markup = ""
  let threw = null

  try {
    const mod = await import(new URL(c.module, import.meta.url).href)
    const Component = mod.default
    if (typeof Component !== "function") {
      throw new Error(`${c.module} has no default-exported component`)
    }
    markup = renderToStaticMarkup(React.createElement(Component, c.props))
  } catch (err) {
    threw = err
  }

  if (threw) {
    failures.push(`${c.name}: threw while rendering — ${String(threw?.message || threw).split("\n")[0]}`)
    if (threw?.stack) {
      const frame = String(threw.stack)
        .split("\n")
        .find((l) => l.includes("/src/"))
      if (frame) failures.push(`${c.name}:   at ${frame.trim()}`)
    }
    lines.push(`${paint.red(" fail")}  ${c.name}`)
    continue
  }

  const problems = []
  if (markup.length < 200) problems.push(`rendered only ${markup.length} characters`)
  for (const needle of c.expect) {
    if (!markup.includes(needle)) problems.push(`output is missing "${needle}"`)
  }
  for (const banned of FORBIDDEN) {
    if (markup.includes(banned)) problems.push(`output still contains "${banned}"`)
  }

  for (const message of captured) {
    notices.push(`${c.name}: react said — ${message.split("\n")[0]}`)
  }

  if (problems.length) {
    for (const p of problems) failures.push(`${c.name}: ${p}`)
    lines.push(`${paint.red(" fail")}  ${c.name}`)
  } else {
    lines.push(
      `${paint.green("  ok ")}  ${c.name}${paint.dim(` \u2014 ${markup.length.toLocaleString("en-US")} chars of markup`)}`,
    )
  }
}

console.error = realError
console.warn = realWarn

for (const line of lines) console.log(line)
console.log()

if (notices.length) {
  console.log(paint.amber(`${notices.length} render warning(s):`))
  for (const n of notices.slice(0, 10)) console.log(`  ${n}`)
  console.log()
}

if (failures.length) {
  console.log(paint.red(paint.bold(`${failures.length} problem(s):`)))
  for (const f of failures) console.log(`  ${f}`)
  console.log()
  process.exit(1)
}

console.log(paint.green(paint.bold("both tabs render, populated and empty")))
process.exit(0)
