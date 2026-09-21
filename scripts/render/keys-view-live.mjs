/* ==========================================================================
   keys-view-live — the API-key screen at #/dashboard/keys, mounted for real
   --------------------------------------------------------------------------
   check-keys-live covers the *console* mint flow (src/pages/console/
   KeysTab.jsx). This one covers the RageStar dashboard screen the user actually
   lands on at http://localhost:5177/#/dashboard/keys — Dashboard.jsx's
   KeysView — because the two are different components with different code
   paths and only one of them was reported broken.

   The screen is driven through a workspace double (see stubs/workspace-live)
   so the interesting cases can be reproduced exactly:

     A. the gateway refuses the write — createKey() rejects
     B. the gateway accepts it but returns no secret — api_key missing
     C. the gateway is not configured at all — actions === null

   In every case the question is the same and it is a UX question, not a
   plumbing one: *can the user see what happened?* A failure that renders its
   message behind the modal's own backdrop is a failure the user cannot see,
   which is exactly what "stuck on blur screen" looks like from the outside.
   ========================================================================== */

/* jsdom first — everything imported afterwards must see a live DOM. */
const { JSDOM } = await import("jsdom")

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://render-test.example.com/#/dashboard/keys", pretendToBeVisual: true },
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
for (const key of [
  "window",
  "document",
  "location",
  "localStorage",
  "sessionStorage",
  "CustomEvent",
  "Event",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
]) {
  promote(key, dom.window[key])
}

await import("./globals.mjs")

const React = (await import("react")).default
const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const Dashboard = (await import("../../src/ragestar/dashboard/Dashboard.jsx")).default

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* Same targeted noise gate as admin-live: KeyWatch polls on a timer and every
   tick logs an act() warning long after the assertions are done. */
const realError = console.error.bind(console)
const ACT_NOISE = /was not wrapped in act\(/
console.error = (...args) => {
  if (typeof args[0] === "string" && ACT_NOISE.test(args[0])) return
  realError(...args)
}

/* ------------------------------------------------------------------ helpers */

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

const settle = (ms = 60) => act(async () => {
  await new Promise((r) => setTimeout(r, ms))
})

const buttons = () => [...document.querySelectorAll("button")]
const byText = (needle) =>
  buttons().find((b) => (b.textContent || "").trim().toLowerCase().includes(needle.toLowerCase()))

const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  })
  await settle()
}

/* React keeps its own record of an input's value, so assigning `.value`
   directly is invisible to it: the change is already reflected when React
   compares, the synthetic onChange never fires, and the field silently keeps
   its previous state. Go through the native setter, exactly like a real
   keystroke arriving from the browser. */
const setInput = async (el, value) => {
  const proto =
    el.tagName === "TEXTAREA"
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  await act(async () => {
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
  await settle()
}

/* The create dialog: the fixed overlay that holds the "Create API key"
   heading. Everything inside it is what the user can actually read while the
   blurred backdrop is up; anything rendered outside it is behind the blur. */
const dialogByHeading = (needle) =>
  [...document.querySelectorAll("div.fixed")].find((d) =>
    (d.textContent || "").includes(needle),
  )

/**
 * Mount the dashboard on the keys view with a given workspace object, open
 * the create dialog, submit it, and report where the outcome landed.
 */
async function runCreate({ ws, label, name, timeoutMs = 0, expiry = "", pastDate = "" }) {
  boundaryError = null
  globalThis.__WS_FIXTURE__ = { ws }

  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)

  await act(async () => {
    root.render(
      React.createElement(
        Boundary,
        null,
        React.createElement(Dashboard, {
          view: "keys",
          /* The shell reads session.org / session.plan for the sidebar badge. */
          session: {
            user: { email: "dev@example.com" },
            profile: { plan: "dev" },
            org: "acme",
            plan: "dev",
            name: "Dev User",
            email: "dev@example.com",
          },
          navigate: () => {},
          onExit: () => {},
          onSignOut: () => {},
        }),
      ),
    )
  })
  await settle()

  const openBtn = byText("Create key")
  if (!openBtn) {
    return { label, fatal: "could not find the 'Create key' button" }
  }
  await click(openBtn)

  const dialog = dialogByHeading("Create API key")
  if (!dialog) return { label, fatal: "create dialog never opened" }

  /* Capture the dialog's semantics and its field set before submitting — the
     panel is replaced once the reveal state takes over. */
  const panel = dialog.querySelector('[role="dialog"]')
  const dialogRole = panel?.getAttribute("role") ?? null
  const ariaModal = panel?.getAttribute("aria-modal") ?? null
  const presetLabels = ["never", "30 days", "90 days", "1 year", "pick a date"]
  const expiryPresets = [...dialog.querySelectorAll("button")].filter((b) =>
    presetLabels.includes((b.textContent || "").trim().toLowerCase()),
  ).length
  const hasCapInput = !!dialog.querySelector('input[type="number"]')

  if (name) {
    const input = dialog.querySelector("input")
    await setInput(input, name)
  }

  /* Pick an expiry preset when the scenario asks for one — the buttons are
     labelled ("30 days", "Never", …), so match on the visible text. */
  if (expiry) {
    const preset = [...dialog.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim().toLowerCase() === expiry.toLowerCase(),
    )
    if (!preset) return { label, fatal: `no "${expiry}" expiry preset in the dialog` }
    await click(preset)
  }

  /* The date field only renders once the custom preset is chosen. */
  if (pastDate) {
    const dateInput = dialog.querySelector('input[type="date"]')
    if (!dateInput) {
      return { label, fatal: "no date field after choosing the custom preset" }
    }
    await setInput(dateInput, pastDate)
  }

  const hasDateInput = !!dialog.querySelector('input[type="date"]')

  const submit = [...dialog.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes("Create secret key"),
  )
  if (!submit) return { label, fatal: "no submit button in the dialog" }

  await click(submit)
  await settle(120)

  /* Some paths (a hung request racing a timeout) only resolve after a wait
     longer than the default settle. Advance far enough that the create path's
     own timeout has fired and React has flushed the resulting state. */
  if (timeoutMs) await settle(timeoutMs)

  const stillOpen = !!dialogByHeading("Create API key")
  const dialogText = (dialogByHeading("Create API key")?.textContent || "").trim()
  const revealed = dialogByHeading("created")
  const revealedText = (revealed?.textContent || "").trim()

  /* Whether the primary action is usable again — a modal whose submit button
     is still disabled/busy after the outcome is a dead end. */
  const submitBtn = stillOpen
    ? [...(dialogByHeading("Create API key")?.querySelectorAll("button") || [])].find((b) =>
        (b.textContent || "").includes("Create secret key"),
      )
    : null
  const submitReenabled = !!submitBtn && !submitBtn.disabled

  /* Text the user can see: the dialog if it is still up, else the page. */
  const visible = stillOpen ? dialogText : (host.textContent || "")

  try {
    await act(async () => root.unmount())
  } catch {}
  host.remove()

  return {
    label,
    boundaryError: boundaryError ? String(boundaryError) : null,
    dialogStillOpen: stillOpen,
    dialogText,
    revealedOpen: !!revealed,
    revealedText,
    revealText: revealedText,
    submitReenabled,
    dialogRole,
    ariaModal,
    expiryPresets,
    hasDateInput,
    hasCapInput,
    visible,
  }
}

/* --------------------------------------------------------------- scenario A
   The gateway refuses the write. This is the everyday case — RLS, budget
   cap, plan limit, revoked session. The screen must say so where the user is
   looking, not in a list behind the modal. */

const REJECTION = "new row violates row-level security policy"

const a = await runCreate({
  label: "A · createKey rejects",
  name: "Prod worker",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      createKey: async () => {
        throw new Error(REJECTION)
      },
      revokeKey: async () => {},
    },
  },
})

if (a.fatal) {
  check("A · create dialog reachable", false, a.fatal)
} else {
  check(
    "A · rejection does not crash the screen",
    !a.boundaryError,
    a.boundaryError || "",
  )
  check(
    "A · the reason is shown where the user is looking",
    a.visible.includes(REJECTION),
    a.dialogStillOpen
      ? `dialog stayed open; its text was: ${JSON.stringify(a.dialogText.slice(0, 160))}`
      : "dialog closed — message must be on the page",
  )
  check(
    "A · user is not left on a dead-end blur screen",
    !a.dialogStillOpen || a.visible.includes(REJECTION),
    a.dialogStillOpen ? "dialog still open with no visible reason" : "",
  )
}

/* --------------------------------------------------------------- scenario B
   The RPC succeeds but hands back no secret. Silent success is worse than a
   loud failure: the user copies an empty string and discovers it hours later
   in a 401. */

const b = await runCreate({
  label: "B · createKey resolves without api_key",
  name: "Prod worker",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      createKey: async () => ({ id: "k1", name: "Prod worker" }),
      revokeKey: async () => {},
    },
  },
})

if (b.fatal) {
  check("B · create dialog reachable", false, b.fatal)
} else {
  check(
    "B · a blank secret is never presented as success",
    !b.revealedOpen || !/Copy/.test(b.revealedText) || b.revealedText.length > 0 && !b.revealedText.includes("—"),
    `revealed=${b.revealedOpen} text=${JSON.stringify(b.revealedText.slice(0, 160))}`,
  )
  check(
    "B · the missing secret is explained or refused",
    b.visible.length > 0 && (b.revealedOpen ? b.revealedText : b.visible).match(/secret|key|again|support|error|could not|failed/i) !== null,
    JSON.stringify((b.revealedOpen ? b.revealedText : b.visible).slice(0, 200)),
  )
}

/* --------------------------------------------------------------- scenario C
   No gateway configured: actions is null and the screen fabricates a key
   client-side. It must never pass that off as a real key. */

const c = await runCreate({
  label: "C · no gateway (actions === null)",
  name: "Prod worker",
  ws: undefined,
})

if (c.fatal) {
  check("C · create dialog reachable", false, c.fatal)
} else {
  const fabricated = /sk_(live|test)_[a-z0-9]{8,}/i.test(c.visible)
  check(
    "C · a locally invented key is labelled as not real",
    !fabricated || /demo|sample|not real|local only|preview/i.test(c.visible),
    fabricated
      ? `fabricated a sk_… secret with no warning: ${JSON.stringify(c.visible.slice(0, 200))}`
      : "",
  )
}

/* --------------------------------------------------------------- scenario D
   The happy path has to survive the error handling: a real secret must still
   be revealed exactly once, and must *not* be branded as a demo key. */

const REAL_SECRET = "rr_live_7f3a91c4e08b52d6"

/* What the screen handed the data layer, so the dialog's fields can be proved
   to reach createKey() rather than only being drawn. */
let dArgs = null

const d = await runCreate({
  label: "D · createKey returns a real secret",
  name: "Prod worker",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      createKey: async (args) => {
        dArgs = args
        return { id: "k1", name: "Prod worker", api_key: REAL_SECRET }
      },
      revokeKey: async () => {},
    },
  },
})

if (d.fatal) {
  check("D · create dialog reachable", false, d.fatal)
} else {
  check("D · the create dialog closes on success", !d.dialogStillOpen, "still open")
  check(
    "D · the real secret is revealed",
    d.revealedOpen && d.revealedText.includes(REAL_SECRET),
    d.revealedOpen ? JSON.stringify(d.revealedText.slice(0, 160)) : "no reveal dialog",
  )
  check(
    "D · a real key is not branded as a demo key",
    !/demo/i.test(d.revealedText),
    JSON.stringify(d.revealedText.slice(0, 160)),
  )
  /* The dialog is a real dialog, not a bare div: role + aria-modal are what
     let a screen reader treat the page behind it as inert. */
  check(
    "D · the create box is a real modal dialog",
    d.dialogRole === "dialog" && d.ariaModal === "true",
    `role=${d.dialogRole} aria-modal=${d.ariaModal}`,
  )
  check(
    "D · the dialog asks for a name, an expiry and a cap",
    d.expiryPresets >= 4 && d.hasCapInput,
    `expiry presets=${d.expiryPresets} cap input=${d.hasCapInput}`,
  )
  check(
    "D · the name the user typed reaches createKey()",
    dArgs?.name === "Prod worker",
    `sent name=${JSON.stringify(dArgs?.name)}`,
  )
  check(
    "D · the default expiry is “never” — no date is sent",
    dArgs !== null && dArgs.expiresAt === null,
    `sent expiresAt=${JSON.stringify(dArgs?.expiresAt)}`,
  )
  check(
    "D · the reveal states the key's expiry",
    /expires/i.test(d.revealedText),
    JSON.stringify(d.revealedText.slice(0, 200)),
  )
}

/* --------------------------------------------------------------- scenario F
   The expiry the user picks has to reach the data layer as a real, future
   timestamp — the router enforces it, so a dialog that only *looked* like it
   set one would ship keys that never expire. */

let fArgs = null

const f = await runCreate({
  label: "F · the chosen expiry reaches createKey()",
  name: "Prod worker",
  expiry: "30 days",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      createKey: async (args) => {
        fArgs = args
        return { id: "k1", name: "Prod worker", api_key: REAL_SECRET }
      },
      revokeKey: async () => {},
    },
  },
})

if (f.fatal) {
  check("F · create dialog reachable", false, f.fatal)
} else {
  const when = fArgs?.expiresAt ? new Date(fArgs.expiresAt).getTime() : NaN
  const days = (when - Date.now()) / 86_400_000
  check(
    "F · a preset expiry is sent as a future ISO timestamp",
    Number.isFinite(when) && days > 29 && days < 31,
    `sent expiresAt=${JSON.stringify(fArgs?.expiresAt)} (${Number.isFinite(days) ? days.toFixed(2) : "n/a"} days out)`,
  )
  check(
    "F · the expiry is echoed back in the reveal",
    f.revealedOpen && /30 days/i.test(f.revealedText),
    JSON.stringify(f.revealedText.slice(0, 200)),
  )
}

/* --------------------------------------------------------------- scenario G
   Validation: a date already in the past must be refused inside the dialog
   rather than minting a key the router rejects on its first call. */

let gCalled = false

const g = await runCreate({
  label: "G · a past expiry is refused locally",
  name: "Prod worker",
  expiry: "pick a date",
  pastDate: "2020-01-01",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      createKey: async () => {
        gCalled = true
        return { id: "k1", name: "Prod worker", api_key: REAL_SECRET }
      },
      revokeKey: async () => {},
    },
  },
})

if (g.fatal) {
  check("G · create dialog reachable", false, g.fatal)
} else {
  check(
    "G · the date field appears with the custom preset",
    g.hasDateInput,
    "no input[type=date] in the dialog",
  )
  check(
    "G · a past date never reaches the gateway",
    gCalled === false,
    "createKey() was called with an expiry in the past",
  )
  check(
    "G · the dialog explains why it refused",
    /passed|future|never/i.test(g.dialogText) && g.dialogStillOpen,
    JSON.stringify(g.dialogText.slice(0, 200)),
  )
}

/* --------------------------------------------------------------- scenario E
   The write never resolves — a stalled network or a dropped edge call. Without
   a timeout the modal's blurred backdrop stays up with the button spinning and
   the process never completes, which is the literal "screen blurs and nothing
   happens" report. The create path races the write against a 30s timeout, so
   after that the dialog must be back to a readable, actionable state: still
   open (so the user can retry), no longer busy, and showing a reason. */

const e = await runCreate({
  label: "E · createKey hangs forever",
  name: "Prod worker",
  ws: {
    live: true,
    loading: false,
    error: null,
    keys: [],
    refresh: () => {},
    actions: {
      /* never resolves */
      createKey: () => new Promise(() => {}),
      revokeKey: async () => {},
    },
  },
  timeoutMs: 31000,
})

if (e.fatal) {
  check("E · create dialog reachable", false, e.fatal)
} else {
  check(
    "E · a hung request does not crash the screen",
    !e.boundaryError,
    e.boundaryError || "",
  )
  check(
    "E · a hung request cannot freeze the blur screen forever",
    e.dialogStillOpen && /timed out|try again|connection/i.test(e.dialogText),
    e.dialogStillOpen
      ? `dialog text: ${JSON.stringify(e.dialogText.slice(0, 200))}`
      : "dialog closed instead of surfacing the timeout",
  )
  check(
    "E · the submit button is interactive again after a hang",
    e.submitReenabled,
    e.submitReenabled ? "" : "submit stayed disabled/busy after the timeout",
  )
}

/* ------------------------------------------------------------------ report */

const width = Math.max(...results.map((r) => r.name.length))
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  const tag = r.ok ? " ok " : "FAIL"
  console.log(`${tag}  ${r.name.padEnd(width)}${r.ok ? "" : "  ← " + r.detail}`)
}
console.log()
console.log(`${results.length - failed}/${results.length} passed`)

console.error = realError
dom.window.close()
process.exit(failed ? 1 : 0)
