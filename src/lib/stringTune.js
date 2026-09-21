/* ==========================================================================
   StringTune runtime bridge
   --------------------------------------------------------------------------
   The UI layer of this app is built on StringTune (@fiddle-digital/string-tune):
   a tiny scroll/interaction engine driven by `string="..."` attributes that
   writes normalised values into CSS custom properties (`--progress`, ...).
   Components in `src/components/string/` are thin React bindings over it.

   Loading strategy
   1. Try the CDN bundle and register the modules we use (Progress, Lazy, Split).
   2. If the CDN is unreachable (offline, blocked, air-gapped CI, screenshot
      runs), start a local micro-engine that honours the exact same attribute
      contract, so nothing ever renders half-animated or with a blank image.

   Every consumer only talks to attributes + CSS vars, so both paths are
   visually identical.
   ========================================================================== */

const CDN_URL =
  "https://unpkg.com/@fiddle-digital/string-tune@1.2.1/dist/index.js";
const LOAD_TIMEOUT = 3500;

/* Loading a third-party bundle at runtime is a code-execution dependency: if
   that CDN is ever compromised, the attacker runs script in every session. It
   is disabled by default (and blocked by the Content-Security-Policy); the
   bundled micro-engine below renders the same motion. Opt in with
   VITE_ENABLE_REMOTE_MOTION=true. */
const REMOTE_MOTION = String(import.meta.env?.VITE_ENABLE_REMOTE_MOTION || "") === "true";

let mode = "pending"; // "pending" | "library" | "local"
let bootPromise = null;
let instance = null;
let localEngine = null;

export function getStringMode() {
  return mode;
}

/* ------------------------------------------------------------------ boot */
export function bootStringTune() {
  if (bootPromise) return bootPromise;
  if (typeof window === "undefined") return Promise.resolve("pending");

  bootPromise = loadScript()
    .then((lib) => {
      instance = startLibrary(lib);
      mode = "library";
      return mode;
    })
    .catch(() => {
      localEngine = startLocalEngine();
      mode = "local";
      return mode;
    })
    .then((m) => {
      document.documentElement.setAttribute("data-string-engine", m);
      return m;
    });

  return bootPromise;
}

/* Re-scan the DOM after a route change / list render. */
export function rescanStringTune() {
  if (instance) {
    try {
      if (typeof instance.rescan === "function") instance.rescan();
      else if (typeof instance.update === "function") instance.update();
      else if (typeof instance.start === "function") instance.start(0);
    } catch (e) {
      /* engine already running — nothing to do */
    }
  }
  if (localEngine) localEngine.scan();
}

/* -------------------------------------------------------------- CDN path */
function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.StringTune) return resolve(window.StringTune);
    if (!REMOTE_MOTION) return reject(new Error("remote motion engine disabled"));

    const existing = document.querySelector("script[data-string-tune]");
    const el = existing || document.createElement("script");
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok && window.StringTune) resolve(window.StringTune);
      else reject(new Error("string-tune unavailable"));
    };

    const timer = setTimeout(() => done(false), LOAD_TIMEOUT);
    el.addEventListener("load", () => done(true));
    el.addEventListener("error", () => done(false));

    if (!existing) {
      el.src = CDN_URL;
      el.async = true;
      el.dataset.stringTune = "cdn";
      document.head.appendChild(el);
    } else if (window.StringTune) {
      done(true);
    }
  });
}

function startLibrary(lib) {
  const Root = lib.StringTune || lib;
  const st =
    typeof Root.getInstance === "function" ? Root.getInstance() : new Root();
  window.StringTuneContext = st;

  ["StringLazy", "StringProgress", "StringSplit", "StringSticky"].forEach(
    (name) => {
      const mod = lib[name];
      if (mod && typeof st.use === "function") {
        try {
          st.use(mod);
        } catch (e) {
          /* module not in this build — skip */
        }
      }
    }
  );

  if (typeof st.start === "function") st.start(0);
  return st;
}

/* ------------------------------------------------------- local micro-engine
   Implements `string="progress"` (+ `string-enter-vp` / `string-exit-vp`)
   and `string="lazy"` (+ `string-lazy`). ~1kb of behaviour, no deps.        */
function startLocalEngine() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tracked = new Set();
  const active = new Set();
  let raf = 0;

  const LINES = { top: 0, center: 0.5, bottom: 1 };
  const lineOf = (value, fallback) => {
    const key = (value || "").toLowerCase();
    return key in LINES ? LINES[key] : fallback;
  };

  const io =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) active.add(entry.target);
              else active.delete(entry.target);
            });
            if (active.size) loop();
          },
          { rootMargin: "20% 0px 20% 0px" }
        )
      : null;

  const write = (el) => {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    const enter = lineOf(el.getAttribute("string-enter-vp"), 1);
    const exit = lineOf(el.getAttribute("string-exit-vp"), 0);

    let span = rect.height + (enter - exit) * vh;
    if (span < 1) span = rect.height + vh;

    const travelled = enter * vh - rect.top;
    const p = Math.max(0, Math.min(1, travelled / span));

    el.style.setProperty("--progress", p.toFixed(4));
    el.classList.toggle("is-str-active", p > 0 && p < 1);
    if (p > 0) el.classList.add("is-str-seen");
  };

  const loop = () => {
    if (raf) return;
    raf = requestAnimationFrame(function step() {
      raf = 0;
      active.forEach(write);
      if (active.size) loop();
    });
  };

  const hydrateLazy = (el) => {
    if (el.dataset.strLazy === "done") return;
    const src = el.getAttribute("string-lazy");
    if (!src) return;
    el.dataset.strLazy = "done";
    if (el.tagName === "IMG") el.setAttribute("src", src);
    else el.style.backgroundImage = `url("${src}")`;
    el.classList.add("is-str-loaded");
  };

  const scan = () => {
    document.querySelectorAll('[string="lazy"]').forEach(hydrateLazy);
    document.querySelectorAll('[string="progress"]').forEach((el) => {
      if (tracked.has(el)) return;
      tracked.add(el);
      if (reduced) {
        el.style.setProperty("--progress", "1");
        el.classList.add("is-str-seen");
        return;
      }
      write(el);
      if (io) io.observe(el);
      else active.add(el);
    });
    if (!reduced && active.size) loop();
  };

  scan();

  if (!reduced) {
    window.addEventListener("scroll", loop, { passive: true });
    window.addEventListener("resize", loop, { passive: true });
  }

  if ("MutationObserver" in window) {
    let pending = false;
    /* Cursor FX nodes are added and removed on every click. Rescanning the
       whole document for those wasted a layout pass in the middle of a
       press, so mutations inside the FX layer are ignored. */
    const isFxOnly = (record) => {
      const t = record.target;
      return Boolean(
        t && t.nodeType === 1 && typeof t.closest === "function" && t.closest("[data-fx-layer]")
      );
    };
    new MutationObserver((records) => {
      if (records.length && records.every(isFxOnly)) return;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        scan();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  return { scan };
}
