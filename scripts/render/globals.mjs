/* ==========================================================================
   The smallest browser the components will accept
   --------------------------------------------------------------------------
   Server rendering never runs effects, so nothing here needs to behave like
   a real DOM. It only has to exist, because a module that reads `document`
   or `localStorage` while it is being imported would otherwise throw before
   a single component is rendered.

   Anything a component actually depends on for its output — data, props,
   formatting — is real. Only the browser is fake.
   ========================================================================== */

const noop = () => {}

function define(name, value) {
  try {
    if (globalThis[name] === undefined) globalThis[name] = value
  } catch {
    /* read-only global in this runtime; the code under test can live with it */
  }
}

/* Vite's `import.meta.env`, rewritten into this by the loader. Values are
   obvious placeholders so nothing can mistake them for real config. */
define("__VITE_ENV__", {
  MODE: "test",
  DEV: false,
  PROD: true,
  VITE_SUPABASE_URL: "https://render-test.supabase.co",
  VITE_SUPABASE_ANON_KEY: "render-test-anon-key",
  VITE_GATEWAY_URL: "https://render-test.example.com/v1",
  VITE_SITE_URL: "https://render-test.example.com",
  VITE_FIREBASE_API_KEY: "render-test",
  VITE_FIREBASE_AUTH_DOMAIN: "render-test.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "render-test",
  VITE_FIREBASE_APP_ID: "1:0:web:0",
  VITE_ALLOWED_EMAIL_DOMAINS: "example.com",
})

const store = new Map()
const storage = {
  getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
  setItem: (k, v) => void store.set(String(k), String(v)),
  removeItem: (k) => void store.delete(String(k)),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  },
}
define("localStorage", storage)
define("sessionStorage", storage)

const element = () => ({
  style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => "" },
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  dataset: {},
  children: [],
  setAttribute: noop,
  getAttribute: () => null,
  removeAttribute: noop,
  appendChild: (child) => child,
  removeChild: (child) => child,
  insertBefore: (child) => child,
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
  contains: () => false,
  focus: noop,
  blur: noop,
  remove: noop,
})

define("document", {
  documentElement: element(),
  body: element(),
  head: element(),
  createElement: element,
  createElementNS: element,
  createTextNode: (text) => ({ text }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  readyState: "complete",
  visibilityState: "visible",
  cookie: "",
  fonts: { ready: Promise.resolve(), addEventListener: noop },
})

const mql = () => ({
  matches: false,
  media: "",
  onchange: null,
  addEventListener: noop,
  removeEventListener: noop,
  addListener: noop,
  removeListener: noop,
  dispatchEvent: () => false,
})

define("matchMedia", mql)

/* Components call `window.matchMedia(...)` — not the bare global — and not
   every jsdom build gives its window one. Fill the gap before a component
   asks. */
try {
  if (globalThis.window && typeof globalThis.window.matchMedia !== "function") {
    Object.defineProperty(globalThis.window, "matchMedia", {
      value: mql,
      configurable: true,
      writable: true,
    })
  }
} catch {
  /* window is frozen here; nothing renders differently without it */
}

define("location", {
  href: "https://render-test.example.com/",
  origin: "https://render-test.example.com",
  protocol: "https:",
  host: "render-test.example.com",
  hostname: "render-test.example.com",
  pathname: "/",
  search: "",
  hash: "",
  assign: noop,
  replace: noop,
  reload: noop,
})

define("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0))
define("cancelAnimationFrame", (id) => clearTimeout(id))
define("addEventListener", noop)
define("removeEventListener", noop)
define("dispatchEvent", () => false)
define("scrollTo", noop)
define("getComputedStyle", () => ({ getPropertyValue: () => "" }))
define("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} })
define("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
define("window", globalThis)

if (!globalThis.navigator?.clipboard) {
  try {
    Object.defineProperty(globalThis.navigator ?? (globalThis.navigator = {}), "clipboard", {
      value: { writeText: async () => {} },
      configurable: true,
    })
  } catch {
    /* node 24 exposes a read-only navigator; copy is never called during render */
  }
}
