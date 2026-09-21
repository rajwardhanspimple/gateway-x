/* ==========================================================================
   ux.js — interaction primitives
   --------------------------------------------------------------------------
   Small, dependency-free hooks that make the whole app feel responsive:
   toasts, clipboard, keyboard shortcuts, optimistic async buttons, confirm
   flows, live-region announcements, scroll progress and connection status.

   Everything here degrades gracefully: no animation when the person asked for
   reduced motion, no clipboard API needed, no hotkeys while typing.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { prefersReducedMotion } from "./interactive"

export { prefersReducedMotion }

/* ============================================================== toasts === */

let toastSeq = 0
let toasts = []
const toastListeners = new Set()

const TOAST_LIMIT = 4
const DEFAULT_MS = { ok: 3200, info: 3600, error: 6000, loading: 0 }

function publish() {
  for (const fn of toastListeners) fn(toasts)
}

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id)
  publish()
}

export function clearToasts() {
  toasts = []
  publish()
}

/**
 * Show a toast. Returns its id so a "loading" toast can be replaced later.
 *   toast("Key copied")
 *   toast.error("Could not revoke that key")
 *   const id = toast.loading("Rotating…"); toast.ok("Rotated", { id })
 */
export function toast(message, options = {}) {
  const {
    id = null,
    tone = "ok",
    title = "",
    duration,
    action = null, // { label, onClick }
  } = typeof options === "string" ? { tone: options } : options

  const text = String(message ?? "").trim()
  if (!text && !title) return null

  const ms = duration == null ? DEFAULT_MS[tone] ?? DEFAULT_MS.info : duration
  const next = {
    id: id || `t${++toastSeq}`,
    tone,
    title,
    message: text,
    action,
    duration: ms,
    at: Date.now(),
  }

  const existing = toasts.findIndex((t) => t.id === next.id)
  if (existing >= 0) toasts = toasts.map((t, i) => (i === existing ? next : t))
  else toasts = [...toasts, next].slice(-TOAST_LIMIT)

  publish()
  return next.id
}

toast.ok = (m, o = {}) => toast(m, { ...o, tone: "ok" })
toast.success = toast.ok
toast.error = (m, o = {}) => toast(m, { ...o, tone: "error" })
toast.info = (m, o = {}) => toast(m, { ...o, tone: "info" })
toast.loading = (m, o = {}) => toast(m, { ...o, tone: "loading", duration: 0 })

export function useToasts() {
  const [list, setList] = useState(toasts)
  useEffect(() => {
    const fn = (next) => setList(next)
    toastListeners.add(fn)
    setList(toasts)
    return () => toastListeners.delete(fn)
  }, [])
  return list
}

/* ====================================================== screen readers === */

const announcers = new Set()

/** Speak a message through the app's polite live region. */
export function announce(message) {
  const text = String(message ?? "").trim()
  if (!text) return
  for (const fn of announcers) fn(text)
}

export function useAnnouncer() {
  const [message, setMessage] = useState("")
  useEffect(() => {
    const fn = (text) => {
      /* re-announce identical text by blanking first */
      setMessage("")
      window.setTimeout(() => setMessage(text), 40)
    }
    announcers.add(fn)
    return () => announcers.delete(fn)
  }, [])
  return message
}

/* =========================================================== clipboard === */

async function writeClipboard(text) {
  const value = String(text ?? "")
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* insecure context or permission denied — fall through */
  }
  try {
    const el = document.createElement("textarea")
    el.value = value
    el.setAttribute("readonly", "")
    el.style.position = "fixed"
    el.style.top = "-1000px"
    el.style.opacity = "0"
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/**
 * Clipboard with built-in feedback.
 *   const { copy, copied } = useCopy()
 *   <button onClick={() => copy(key, "API key")}>{copied ? "Copied" : "Copy"}</button>
 */
export function useCopy({ label = "Copied", quiet = false, resetMs = 1600 } = {}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback(
    async (text, what = "") => {
      const ok = await writeClipboard(text)
      if (ok) {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), resetMs)
        const message = what ? `${what} copied` : label
        if (!quiet) toast.ok(message)
        announce(message)
      } else if (!quiet) {
        toast.error("Your browser blocked the clipboard. Select the text and copy manually.")
      }
      return ok
    },
    [label, quiet, resetMs],
  )

  return { copy, copied }
}

/* ============================================================ hotkeys === */

const MOD = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "")
  ? "meta"
  : "ctrl"

/** "⌘" on Apple hardware, "Ctrl" elsewhere — for labels. */
export const MOD_LABEL = MOD === "meta" ? "⌘" : "Ctrl"

function comboOf(event) {
  const parts = []
  if (event.metaKey) parts.push("meta")
  if (event.ctrlKey) parts.push("ctrl")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  const key = String(event.key || "").toLowerCase()
  parts.push(key === " " ? "space" : key)
  return parts.join("+")
}

function normalise(combo) {
  return String(combo)
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .map((p) => (p === "mod" || p === "cmd" ? MOD : p))
    .filter(Boolean)
    .sort((a, b) => {
      const order = { meta: 0, ctrl: 1, alt: 2, shift: 3 }
      return (order[a] ?? 9) - (order[b] ?? 9)
    })
    .join("+")
}

function isTypingTarget(target) {
  const el = target
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    el.isContentEditable === true
  )
}

/**
 * Global keyboard shortcuts.
 *   useHotkeys({ "mod+k": openPalette, "?": openHelp, escape: close })
 * Shortcuts are ignored while typing unless `allowInInput` is set.
 */
export function useHotkeys(map, { allowInInput = false, enabled = true } = {}) {
  const ref = useRef(map)
  ref.current = map

  useEffect(() => {
    if (!enabled) return undefined
    const onKey = (event) => {
      const handlers = ref.current || {}
      const combo = comboOf(event)
      let match = null
      for (const key of Object.keys(handlers)) {
        const wanted = normalise(key)
        if (wanted === normalise(combo)) {
          match = handlers[key]
          break
        }
      }
      if (!match) return
      const typing = isTypingTarget(event.target)
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey
      if (typing && !allowInInput && bare && event.key !== "Escape") return
      event.preventDefault()
      match(event)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [allowInInput, enabled])
}

/* ====================================================== async actions === */

/**
 * Wraps an async action with busy state, error capture and optional toasts —
 * so every button in the app can show progress without repeating the pattern.
 *
 *   const save = useAsyncAction(saveSettings, { success: "Settings saved" })
 *   <Button loading={save.busy} onClick={save.run}>Save</Button>
 */
export function useAsyncAction(fn, { success = "", failure = "", quiet = false } = {}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)
  const alive = useRef(true)
  const running = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    async (...args) => {
      /* double-click guard: a second press while busy is ignored */
      if (running.current) return undefined
      running.current = true
      setBusy(true)
      setError("")
      setDone(false)
      try {
        const result = await fn(...args)
        if (alive.current) {
          setDone(true)
          window.setTimeout(() => alive.current && setDone(false), 1800)
        }
        if (success && !quiet) toast.ok(success)
        if (success) announce(success)
        return result
      } catch (err) {
        const message = err?.message || failure || "That did not work. Try again."
        if (alive.current) setError(message)
        if (!quiet) toast.error(message)
        return undefined
      } finally {
        running.current = false
        if (alive.current) setBusy(false)
      }
    },
    [fn, success, failure, quiet],
  )

  return { run, busy, error, done, reset: () => setError("") }
}

/**
 * Two-step confirmation without a modal: the first click arms the button,
 * the second one commits, and it disarms itself after a few seconds.
 */
export function useArmed(ms = 4000) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const arm = useCallback(() => {
    setArmed(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setArmed(false), ms)
  }, [ms])

  const disarm = useCallback(() => {
    window.clearTimeout(timer.current)
    setArmed(false)
  }, [])

  return { armed, arm, disarm }
}

/* =========================================================== storage === */

/** useState that survives a reload (and ignores private-mode failures). */
export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : JSON.parse(raw)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota or private mode — state stays in memory */
    }
  }, [key, value])

  return [value, setValue]
}

/* ============================================================ helpers === */

export function useDebounced(value, ms = 220) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    let mq
    try {
      mq = window.matchMedia(query)
    } catch {
      return undefined
    }
    const fn = (event) => setMatches(event.matches)
    mq.addEventListener?.("change", fn)
    setMatches(mq.matches)
    return () => mq.removeEventListener?.("change", fn)
  }, [query])
  return matches
}

/** Reading progress for long pages; also writes --rs-scroll for CSS. */
export function useScrollProgress() {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const doc = document.documentElement
      const max = doc.scrollHeight - window.innerHeight
      const value = max > 40 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0
      setProgress(value)
      doc.style.setProperty("--rs-scroll", String(Math.round(value * 1000) / 1000))
    }
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [])
  return progress
}

/** Tells people the moment the network drops — before a request fails. */
export function useConnectionToasts() {
  useEffect(() => {
    const offline = () =>
      toast("You are offline. Changes will fail until the connection returns.", {
        id: "net",
        tone: "error",
        duration: 0,
      })
    const online = () => toast.ok("Back online", { id: "net" })
    window.addEventListener("offline", offline)
    window.addEventListener("online", online)
    if (navigator.onLine === false) offline()
    return () => {
      window.removeEventListener("offline", offline)
      window.removeEventListener("online", online)
    }
  }, [])
}

/** Focus trap + Escape handling for dialogs and the command palette. */
export function useFocusTrap(active, containerRef, onClose) {
  useEffect(() => {
    if (!active || !containerRef.current) return undefined
    const root = containerRef.current
    const previous = document.activeElement

    const focusables = () =>
      Array.from(
        root.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)

    const first = focusables()[0]
    first?.focus?.()

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose?.()
        return
      }
      if (event.key !== "Tab") return
      const items = focusables()
      if (!items.length) return
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault()
        lastEl.focus()
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }

    root.addEventListener("keydown", onKey)
    return () => {
      root.removeEventListener("keydown", onKey)
      if (previous instanceof HTMLElement) previous.focus?.()
    }
  }, [active, containerRef, onClose])
}

/** Fuzzy subsequence match used by the command palette. */
export function fuzzyScore(haystack, needle) {
  const text = String(haystack || "").toLowerCase()
  const query = String(needle || "").trim().toLowerCase()
  if (!query) return 1
  if (text.includes(query)) return 100 - text.indexOf(query)

  let score = 0
  let index = 0
  for (const char of query) {
    const found = text.indexOf(char, index)
    if (found === -1) return 0
    score += found === index ? 3 : 1
    index = found + 1
  }
  return score
}
