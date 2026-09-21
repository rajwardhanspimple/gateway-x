/* ==========================================================================
   Interaction kit
   --------------------------------------------------------------------------
   The pieces that turn read-only screens into things you can operate:
   copy buttons, tooltips, switches, icon buttons, two-step destructive
   actions, loading skeletons and empty states with a next step.

   Re-exported from ./index.jsx, so `import { CopyButton } from "../ui"`
   keeps working alongside the existing kit.
   ========================================================================== */

import { useId, useRef, useState } from "react"
import { MOD_LABEL, useArmed, useAsyncAction, useCopy } from "../../lib/ux"
import { CheckIcon } from "./icons.jsx"
import { Spinner } from "./index.jsx"

/* ------------------------------------------------------------------- kbd */

/** Keyboard hint. `mod` renders ⌘ on Apple hardware and Ctrl elsewhere. */
export function Kbd({ children, mod = false }) {
  return (
    <kbd className="rs-kbd">
      {mod ? MOD_LABEL : null}
      {children}
    </kbd>
  )
}

/* --------------------------------------------------------------- tooltip */

/**
 * Hover *and* focus tooltip, wired with aria-describedby so it is not a
 * mouse-only affordance.
 */
export function Tooltip({ label, children, side = "top" }) {
  const id = useId()
  if (!label) return children
  return (
    <span className="rs-tip-wrap" data-side={side}>
      <span className="rs-tip-trigger" aria-describedby={id}>
        {children}
      </span>
      <span role="tooltip" id={id} className="rs-tip">
        {label}
      </span>
    </span>
  )
}

/* ----------------------------------------------------------- icon button */

/** Square, 40px-plus tap target with an always-present accessible name. */
export function IconButton({
  label,
  onClick,
  children,
  tone = "ghost",
  size = "md",
  disabled = false,
  busy = false,
  ...rest
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`rs-iconbtn rs-iconbtn-${tone} rs-iconbtn-${size}`}
        onClick={onClick}
        disabled={disabled || busy}
        aria-label={label}
        aria-busy={busy || undefined}
        {...rest}
      >
        {busy ? <Spinner /> : children}
      </button>
    </Tooltip>
  )
}

/* ---------------------------------------------------------- copy button */

/**
 * Copy-to-clipboard with inline confirmation, a toast and a live-region
 * announcement. Works with a string or a lazy getter.
 */
export function CopyButton({
  value,
  what = "",
  label = "Copy",
  copiedLabel = "Copied",
  variant = "button",
  className = "",
}) {
  const { copy, copied } = useCopy()
  const resolve = () => (typeof value === "function" ? value() : value)

  if (variant === "icon") {
    return (
      <IconButton
        label={copied ? copiedLabel : label}
        onClick={() => copy(resolve(), what)}
        data-copied={copied || undefined}
      >
        {copied ? (
          <CheckIcon />
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M15 5H6a1 1 0 0 0-1 1v9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        )}
      </IconButton>
    )
  }

  return (
    <button
      type="button"
      className={`rs-copy ${className}`.trim()}
      onClick={() => copy(resolve(), what)}
      data-copied={copied || undefined}
    >
      <span className="rs-copy-ico" aria-hidden="true">
        {copied ? "✓" : "⧉"}
      </span>
      {copied ? copiedLabel : label}
    </button>
  )
}

/** Monospace value + copy control, for keys, IDs and endpoints. */
export function CopyField({ value, what = "", mask = false, label = "" }) {
  const [revealed, setRevealed] = useState(!mask)
  const shown = revealed ? value : "•".repeat(Math.min(28, String(value || "").length || 12))
  return (
    <div className="rs-copyfield">
      {label ? <span className="rs-copyfield-label">{label}</span> : null}
      <code className="rs-copyfield-value" title={revealed ? "" : "Hidden"}>
        {shown}
      </code>
      {mask ? (
        <button
          type="button"
          className="rs-copyfield-btn"
          onClick={() => setRevealed((v) => !v)}
          aria-pressed={revealed}
        >
          {revealed ? "Hide" : "Reveal"}
        </button>
      ) : null}
      <CopyButton value={value} what={what} variant="icon" />
    </div>
  )
}

/* --------------------------------------------------------------- switch */

/** Real switch semantics: role, aria-checked, Space/Enter, 44px target. */
export function Switch({ checked, onChange, label, hint = "", disabled = false }) {
  return (
    <label className="rs-switch" data-disabled={disabled || undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(checked)}
        className="rs-switch-track"
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
      >
        <span className="rs-switch-thumb" aria-hidden="true" />
      </button>
      <span className="rs-switch-text">
        <span className="rs-switch-label">{label}</span>
        {hint ? <span className="rs-switch-hint">{hint}</span> : null}
      </span>
    </label>
  )
}

/* -------------------------------------------------------- confirm button */

/**
 * Destructive actions without a modal: click once to arm, once more to run.
 * The armed state expires on its own, and the label says what will happen.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Click again to confirm",
  success = "",
  tone = "danger",
  size = "",
  disabled = false,
}) {
  const { armed, arm, disarm } = useArmed(4000)
  const action = useAsyncAction(async (...args) => onConfirm?.(...args), { success })

  return (
    <button
      type="button"
      className={`rs-confirm rs-confirm-${tone} ${size ? `rs-confirm-${size}` : ""}`.trim()}
      data-armed={armed || undefined}
      disabled={disabled || action.busy}
      aria-busy={action.busy || undefined}
      onBlur={disarm}
      onClick={async () => {
        if (!armed) {
          arm()
          return
        }
        disarm()
        await action.run()
      }}
    >
      {action.busy ? <Spinner /> : null}
      {armed ? confirmLabel : children}
    </button>
  )
}

/* ------------------------------------------------------------- skeleton */

/** Placeholder that matches the shape of what is loading. */
export function Skeleton({ lines = 3, width = "100%", height = 0, rounded = false }) {
  if (height) {
    return (
      <span
        className={`rs-skel ${rounded ? "rs-skel-round" : ""}`.trim()}
        style={{ width, height }}
        aria-hidden="true"
      />
    )
  }
  return (
    <span className="rs-skel-stack" aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="rs-skel"
          style={{ width: i === lines - 1 ? "62%" : "100%" }}
        />
      ))}
    </span>
  )
}

/** Table-shaped placeholder, so rows do not jump when data lands. */
export function SkeletonRows({ rows = 4, cols = 4 }) {
  return (
    <div className="rs-skel-table" aria-hidden="true">
      {Array.from({ length: rows }).map((_, r) => (
        <div className="rs-skel-row" key={r}>
          {Array.from({ length: cols }).map((__, c) => (
            <span className="rs-skel" key={c} style={{ width: c === 0 ? "40%" : "70%" }} />
          ))}
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------- empty state */

/** An empty screen should still offer the next action. */
export function EmptyState({ icon = null, title, body = "", action = null, hint = "" }) {
  return (
    <div className="rs-empty">
      {icon ? (
        <span className="rs-empty-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h3 className="rs-empty-title">{title}</h3>
      {body ? <p className="rs-empty-body">{body}</p> : null}
      {action}
      {hint ? <p className="rs-empty-hint">{hint}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------ scroll top */

/** Appears once the page is worth scrolling back up. */
export function ScrollTop() {
  const [shown, setShown] = useState(false)
  const frame = useRef(0)

  if (typeof window !== "undefined" && !frame.current) {
    frame.current = 1
    window.addEventListener(
      "scroll",
      () => setShown(window.scrollY > 900),
      { passive: true },
    )
  }

  return (
    <button
      type="button"
      className="rs-scrolltop"
      data-shown={shown || undefined}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      tabIndex={shown ? 0 : -1}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M12 19V6M6 12l6-6 6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
