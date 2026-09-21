/* ==========================================================================
   Toaster — the app's single feedback surface
   --------------------------------------------------------------------------
   Every action that used to fail silently (copy, revoke, save, rotate, sign
   out) now says so here. Mounted once in App.jsx.

   Accessibility: the stack is a polite live region, each toast is dismissible
   with a real button, and the same component hosts the app-wide announcer so
   route changes and background results are spoken too.
   ========================================================================== */

import { useEffect, useRef } from "react"
import { dismissToast, prefersReducedMotion, useAnnouncer, useToasts } from "../../lib/ux"
import { AlertIcon, CheckIcon, InfoIcon } from "./icons.jsx"
import { Spinner } from "./index.jsx"

function ToastIcon({ tone }) {
  if (tone === "loading") return <Spinner />
  if (tone === "error") return <AlertIcon />
  if (tone === "info") return <InfoIcon />
  return <CheckIcon />
}

function Toast({ item }) {
  const timer = useRef(0)
  const paused = useRef(false)

  useEffect(() => {
    if (!item.duration) return undefined
    const start = () => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => dismissToast(item.id), item.duration)
    }
    start()
    return () => window.clearTimeout(timer.current)
  }, [item.id, item.duration])

  /* Hovering or focusing a toast keeps it on screen: nobody should have to
     race a timer to read an error or press its action. */
  const hold = () => {
    paused.current = true
    window.clearTimeout(timer.current)
  }
  const resume = () => {
    if (!item.duration || !paused.current) return
    paused.current = false
    timer.current = window.setTimeout(() => dismissToast(item.id), 1400)
  }

  const reduced = prefersReducedMotion()

  return (
    <div
      className={`rs-toast rs-toast-${item.tone}`}
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={hold}
      onMouseLeave={resume}
      onFocus={hold}
      onBlur={resume}
    >
      <span className="rs-toast-icon" aria-hidden="true">
        <ToastIcon tone={item.tone} />
      </span>

      <div className="rs-toast-body">
        {item.title ? <strong className="rs-toast-title">{item.title}</strong> : null}
        <span className="rs-toast-msg">{item.message}</span>
      </div>

      {item.action ? (
        <button
          type="button"
          className="rs-toast-action"
          onClick={() => {
            try {
              item.action.onClick?.()
            } finally {
              dismissToast(item.id)
            }
          }}
        >
          {item.action.label}
        </button>
      ) : null}

      <button
        type="button"
        className="rs-toast-close"
        onClick={() => dismissToast(item.id)}
        aria-label="Dismiss notification"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M6 6l12 12M18 6L6 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {item.duration && !reduced ? (
        <span
          className="rs-toast-bar"
          style={{ animationDuration: `${item.duration}ms` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}

export default function Toaster() {
  const items = useToasts()
  const announcement = useAnnouncer()

  return (
    <>
      <div className="rs-toaster" aria-live="polite" aria-relevant="additions text">
        {items.map((item) => (
          <Toast key={item.id} item={item} />
        ))}
      </div>

      {/* app-wide announcer: route changes, background results, shortcut hints */}
      <p className="rs-sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
    </>
  )
}
