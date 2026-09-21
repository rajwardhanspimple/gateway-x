/* ==========================================================================
   admin-live — the two-render test the SSR harness cannot run
   --------------------------------------------------------------------------
   check-render mounts a component once with renderToStaticMarkup. The
   v12.10 hooks regression only appeared on the SECOND render — first paint
   while `loading === true`, then the re-render once loadAll() settled — so
   a single SSR pass can never see it. This mounts the real <Admin> in a
   real DOM (jsdom) with the same firebase/supabase stubs the render test
   uses, lets the data layer settle, and asserts:

     1. no render error reached the boundary (the hooks crash did, before)
     2. the admin body actually rendered ("adm-body" is present)
     3. the bare-mode rail payload was pushed up through setNav

   It also regression-tests the chart fix: a Sparkline / AreaChart fed a
   single data point must not emit <path d=" L …"> — the exact console
   error Chrome logged ("Expected moveto path command ('M' or 'm')").

   jsdom is not a project dependency; install it ad hoc with
   `npm i --no-save jsdom`. The runner (check-admin-live.mjs) skips cleanly
   when it is absent, so `npm test` still passes on machines without it.
   ========================================================================== */

/* jsdom first — everything imported afterwards must see a live DOM. */
const { JSDOM } = await import("jsdom")

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div><div id="charts"></div></body></html>',
  { url: "https://render-test.example.com/#/admin", pretendToBeVisual: true },
)

const promote = (key, value) => {
  if (globalThis[key] === undefined) {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      /* read-only global in this runtime — globals.mjs fills the gaps */
    }
  }
}
promote("window", dom.window)
promote("document", dom.window.document)
promote("location", dom.window.location)
promote("localStorage", dom.window.localStorage)
promote("sessionStorage", dom.window.sessionStorage)
promote("CustomEvent", dom.window.CustomEvent)
promote("Event", dom.window.Event)
promote("requestAnimationFrame", dom.window.requestAnimationFrame)
promote("cancelAnimationFrame", dom.window.cancelAnimationFrame)

/* The render harness's browser shims (matchMedia, ResizeObserver, …). */
await import("./globals.mjs")

const React = (await import("react")).default
const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const Admin = (await import("../../src/pages/Admin.jsx")).default
const { Sparkline, AreaChart } = await import("../../src/ragestar/dashboard/chart.jsx")

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* --------------------------------------------------------------- noise gate
   KeyWatch (mounted by DashboardTab inside <Admin>) polls on a 5s interval and
   ticks `now` every second. Those timers keep firing after the assertions are
   done, and every tick React helpfully logs "An update to KeyWatch inside a
   test was not wrapped in act(...)". It is not a failure — it is a component
   doing exactly what it was written to do in a harness that has stopped
   caring. Drop that one message; let everything else through untouched. */
const realError = console.error.bind(console)
const ACT_NOISE = /was not wrapped in act\(/
console.error = (...args) => {
  if (typeof args[0] === "string" && ACT_NOISE.test(args[0])) return
  realError(...args)
}

/* --------------------------------------------------------------- the checks */

const results = []
const check = (name, ok, detail = "") => results.push({ name, ok, detail })

let boundaryError = null
class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) {
    return { err: String(err) }
  }
  componentDidCatch(err) {
    boundaryError = err
  }
  render() {
    return this.state.err
      ? React.createElement("div", { id: "crash" }, this.state.err)
      : this.props.children
  }
}

/* 1 — the real admin panel, bare mode, exactly as the RageStar shell mounts it. */

const navPayloads = []
const root = createRoot(document.getElementById("root"))

await act(async () => {
  root.render(
    React.createElement(
      Boundary,
      null,
      React.createElement(Admin, { bare: true, setNav: (p) => navPayloads.push(p) }),
    ),
  )
})

/* Let loadAll() settle: the stubbed data layer resolves (or rejects) on its
   own microtask schedule, flips `loading` to false, and forces the second
   render — the one that used to abort with "Rendered fewer hooks". */
await act(async () => {
  await new Promise((r) => setTimeout(r, 120))
})

check(
  "admin rendered twice without a render error",
  boundaryError === null,
  boundaryError ? String(boundaryError) : "",
)

const html = document.getElementById("root").innerHTML
check("admin body rendered after load", html.includes("adm-body"), "")

const last = navPayloads[navPayloads.length - 1]
check(
  "rail payload pushed through setNav",
  !!last && Array.isArray(last.tabs) && last.tabs.length === 19,
  `${navPayloads.length} payload(s), tabs: ${last?.tabs?.length ?? "none"}`,
)

/* 2 — the chart fix: single-point series must not emit d=" L …". */

dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0, y: 0, top: 0, left: 0, right: 392, bottom: 244,
    width: 392, height: 244, toJSON: () => ({}),
  }
}

const chartRoot = createRoot(document.getElementById("charts"))
await act(async () => {
  chartRoot.render(
    React.createElement(
      "div",
      null,
      React.createElement(Sparkline, { points: [5] }),
      React.createElement(AreaChart, {
        series: [{ id: "s1", name: "single", color: "#2447E8", values: [3] }],
        labels: ["today"],
      }),
      /* positive control: a real series must still draw a stroke */
      React.createElement(Sparkline, { points: [1, 5, 3, 7, 2] }),
    ),
  )
})

const chartHtml = document.getElementById("charts").innerHTML
check('single-point charts emit no d=" L …" path', !chartHtml.includes('d=" L'), "")
check("multi-point sparkline still draws", /d="M /.test(chartHtml), "")

/* 3 — every tab, mounted on its own.
   The checks above only prove the DEFAULT tab survives two renders. Each of
   the 19 sections is its own subtree with its own hooks, and a crash in one
   of them is exactly as fatal to the user as a crash in the shell — the rail
   stops working and the panel goes blank. A single mount cannot see that, so
   walk the tab list the component itself published through setNav and mount
   each one fresh.

   The address is set BEFORE the mount because `tab` is seeded from the hash
   (tabFromHash → useState initialiser); each tab therefore gets a brand new
   tree rather than a re-render of the previous one, and one tab's crash
   cannot poison the rest of the sweep. */

const tabIds = (last?.tabs ?? []).map((t) => t.id)
const crashed = []
const blank = []

for (const id of tabIds) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dom.window.location.hash = `#/admin/${id}`

  boundaryError = null
  let tabRoot = null
  try {
    tabRoot = createRoot(host)
    await act(async () => {
      tabRoot.render(
        React.createElement(
          Boundary,
          null,
          React.createElement(Admin, { bare: true, setNav: () => {} }),
        ),
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
  } catch (e) {
    boundaryError = boundaryError || e
  }

  const tabHtml = host.innerHTML
  if (boundaryError) crashed.push(`${id}: ${boundaryError}`)
  else if (!tabHtml.includes("adm-body")) blank.push(id)

  try {
    await act(async () => tabRoot?.unmount())
  } catch {
    /* pending tick raced the unmount */
  }
  host.remove()
}

check(
  `all ${tabIds.length} admin tabs mount without crashing`,
  crashed.length === 0,
  crashed.length ? crashed.join(" | ") : "",
)
check(
  "every tab paints a body (no silently empty section)",
  blank.length === 0,
  blank.length ? `empty: ${blank.join(", ")}` : "",
)

/* ------------------------------------------------------------------- report */

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s }

console.log(paint.bold("admin-live"))
console.log()
for (const r of results) {
  const mark = r.ok ? paint.green("  ok  ") : paint.red("  fail")
  console.log(`${mark} ${r.name}${r.detail ? paint.dim(` — ${r.detail}`) : ""}`)
}
console.log()

const failed = results.filter((r) => !r.ok)

/* ------------------------------------------------------------------- teardown
   Nothing here is optional. jsdom owns real timers (KeyWatch's poll loop, the
   1s countdown) and React keeps a scheduler handle on the window, so without
   an explicit unmount + close the process reports its results and then sits
   there forever — which reads as a hung `npm test` even though every check
   passed. Restore console.error first so a late crash still prints. */
console.error = realError

try {
  await act(async () => {
    root.unmount()
    chartRoot.unmount()
  })
} catch {
  /* unmount raced a pending tick; the assertions above already stand */
}

try {
  dom.window.close()
} catch {
  /* already torn down */
}

if (failed.length) {
  console.log(paint.red(`${failed.length} check(s) failed`))
  process.exit(1)
}
console.log(paint.green("all live checks passed"))
/* Exit deliberately: dangling jsdom handles can outlive the report. */
process.exit(0)
