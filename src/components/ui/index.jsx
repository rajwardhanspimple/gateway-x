/* ==========================================================================
   String UI — the app's component kit
   --------------------------------------------------------------------------
   Accessible, token-driven primitives shared by the auth flow and the console.
   Rules baked in (from the product UX guidelines the design pass was built on):
     · every input has a real <label> (never placeholder-only)
     · errors are announced (role="alert") and tied via aria-describedby
     · passwords can be revealed
     · async actions always show loading → result feedback
     · hit targets stay ≥ 44px on touch
   ========================================================================== */

import React, { forwardRef, useId, useRef, useState } from "react";
import {
  AlertIcon,
  CheckIcon,
  DiscordIcon,
  EyeIcon,
  EyeOffIcon,
  GithubIcon,
  GoogleIcon,
  InfoIcon,
} from "./icons.jsx";
import { PASSWORD_RULES, scorePassword } from "../../lib/auth.js";

/* -------------------------------------------------------------- spinner */
export function Spinner({ size = 16, className = "" }) {
  return (
    <span
      className={`sui-spin ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/* --------------------------------------------------------------- button */
export function Button({
  as: Tag = "button",
  variant = "primary",
  size = "md",
  loading = false,
  block = false,
  iconLeft = null,
  iconRight = null,
  className = "",
  children,
  ...rest
}) {
  const isButton = Tag === "button";
  return (
    <Tag
      className={`sui-btn sui-btn-${variant} sui-btn-${size} ${
        block ? "sui-btn-block" : ""
      } ${loading ? "is-loading" : ""} ${className}`}
      aria-busy={loading || undefined}
      disabled={isButton ? rest.disabled || loading : undefined}
      type={isButton ? rest.type || "button" : undefined}
      data-magnetic={variant === "primary" ? "" : undefined}
      {...rest}
    >
      <span className="sui-btn-shine" aria-hidden="true" />
      {loading ? <Spinner /> : iconLeft}
      <span className="sui-btn-label">{children}</span>
      {loading ? null : iconRight}
    </Tag>
  );
}

/* ---------------------------------------------------------------- field */
export function Field({
  label,
  hint,
  error,
  optional = false,
  htmlFor,
  describedBy,
  className = "",
  children,
}) {
  return (
    <div className={`sui-field ${error ? "has-error" : ""} ${className}`}>
      <div className="sui-field-top">
        <label htmlFor={htmlFor}>{label}</label>
        {optional ? <span className="sui-field-opt mono xs">optional</span> : null}
      </div>
      {children}
      {error ? (
        <p className="sui-err" id={describedBy} role="alert">
          <AlertIcon width={13} height={13} />
          {error}
        </p>
      ) : hint ? (
        <p className="sui-hint" id={describedBy}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ text input */
export const TextInput = forwardRef(function TextInput(
  { icon = null, invalid = false, trailing = null, className = "", ...rest },
  ref
) {
  const innerRef = useRef(null);

  /* keep the forwarded ref working while also holding a local handle */
  const attachRef = (node) => {
    innerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  /* A press on the icon, the inner padding or the focus glow landed on this
     wrapper and did nothing at all, so the caret stayed wherever it was and
     it looked like clicks were jumping somewhere else. Any press inside the
     frame now puts the caret in the field. */
  const focusField = (e) => {
    const el = innerRef.current;
    if (!el || e.button !== 0 || e.target === el) return;
    if (e.target.closest && e.target.closest("button, a, input, textarea, select")) return;
    e.preventDefault();
    el.focus();
    try {
      const end = el.value ? el.value.length : 0;
      el.setSelectionRange(end, end);
    } catch (err) {
      /* email / number inputs do not support selection ranges */
    }
  };

  return (
    <span
      className={`sui-input-wrap ${invalid ? "is-invalid" : ""} ${className}`}
      onMouseDown={focusField}
    >
      {icon ? (
        <span className="sui-input-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <input
        ref={attachRef}
        className={`sui-input ${icon ? "has-icon" : ""}`}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {trailing ? <span className="sui-input-trail">{trailing}</span> : null}
      <span className="sui-input-glow" aria-hidden="true" />
    </span>
  );
});

/* -------------------------------------------------------- password input */
export const PasswordInput = forwardRef(function PasswordInput(
  { icon = null, invalid = false, className = "", onKeyUp, onBlur, ...rest },
  ref
) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);

  return (
    <>
      <TextInput
        ref={ref}
        /* caller props go first: spreading them last silently replaced the
           reveal button and the caps-lock watcher defined below */
        {...rest}
        type={shown ? "text" : "password"}
        icon={icon}
        invalid={invalid}
        className={className}
        onKeyUp={(e) => {
          if (e.getModifierState) setCaps(e.getModifierState("CapsLock"));
          if (onKeyUp) onKeyUp(e);
        }}
        onBlur={(e) => {
          setCaps(false);
          if (onBlur) onBlur(e);
        }}
        trailing={
          <button
            type="button"
            className="sui-reveal"
            onClick={() => setShown((s) => !s)}
            aria-pressed={shown}
            aria-label={shown ? "Hide password" : "Show password"}
          >
            {shown ? <EyeOffIcon width={16} height={16} /> : <EyeIcon width={16} height={16} />}
          </button>
        }
      />
      {caps ? (
        <span className="sui-caps mono xs" role="status">
          caps lock is on
        </span>
      ) : null}
    </>
  );
});

/* ----------------------------------------------------- password strength */
export function PasswordStrength({ value = "", showRules = true }) {
  /* Defensive defaults. A single missing field used to throw
     "Cannot read properties of undefined (reading 'includes')" and take the
     whole signup page down with it, so nothing here is assumed. */
  const {
    score = 0,
    percent = 0,
    label = "",
    passed = [],
  } = scorePassword(value) || {};
  const met = Array.isArray(passed) ? passed : [];
  const pct = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const tone = ["none", "weak", "fair", "good", "best"][score] || "none";

  return (
    <div className="sui-strength" data-tone={tone}>
      <div className="sui-strength-bar" aria-hidden="true">
        <i style={{ width: `${value ? Math.max(pct, 8) : 0}%` }} />
      </div>
      <div className="sui-strength-top">
        <span className="mono xs faint">password strength</span>
        <span className="mono xs sui-strength-label" role="status">
          {value ? label : "—"}
        </span>
      </div>
      {showRules ? (
        <ul className="sui-rules">
          {PASSWORD_RULES.map((rule) => {
            const ok = met.includes(rule.id);
            return (
              <li key={rule.id} className={ok ? "is-ok" : ""}>
                <span className="sui-rule-dot" aria-hidden="true">
                  {ok ? <CheckIcon width={11} height={11} /> : null}
                </span>
                {rule.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- checkbox */
export function Checkbox({ id, checked, onChange, invalid = false, children }) {
  const auto = useId();
  const inputId = id || auto;
  return (
    <label className={`sui-check ${invalid ? "is-invalid" : ""}`} htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid || undefined}
      />
      <span className="sui-check-box" aria-hidden="true">
        <CheckIcon width={12} height={12} />
      </span>
      <span className="sui-check-label">{children}</span>
    </label>
  );
}

/* ------------------------------------------------------------- segmented */
export function Segmented({ options, value, onChange, ariaLabel = "Choose an option" }) {
  return (
    <div className="sui-seg" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          type="button"
          aria-selected={value === opt.value}
          className={value === opt.value ? "is-on" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon ? <span className="sui-seg-icon">{opt.icon}</span> : null}
          {opt.label}
          {opt.meta ? <em className="mono xs">{opt.meta}</em> : null}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- alert */
export function Alert({ tone = "error", title, children, action = null }) {
  const Icon = tone === "ok" ? CheckIcon : tone === "info" ? InfoIcon : AlertIcon;
  return (
    <div
      className={`sui-alert sui-alert-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon width={16} height={16} />
      <div className="sui-alert-body">
        {title ? <strong>{title}</strong> : null}
        {children ? <span>{children}</span> : null}
      </div>
      {action}
    </div>
  );
}

/* --------------------------------------------------------------- divider */
export function Divider({ children }) {
  return (
    <div className="sui-div">
      <span aria-hidden="true" />
      {children ? <em className="mono xs">{children}</em> : null}
      <span aria-hidden="true" />
    </div>
  );
}

/* ----------------------------------------------------------------- oauth */
const OAUTH = {
  github: { label: "GitHub", Icon: GithubIcon },
  google: { label: "Google", Icon: GoogleIcon },
  discord: { label: "Discord", Icon: DiscordIcon },
};

export function OAuthButton({ provider = "github", onClick, busy = false, disabled }) {
  const meta = OAUTH[provider] || OAUTH.github;
  const { Icon } = meta;
  return (
    <button
      type="button"
      className="sui-oauth"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Spinner size={15} /> : <Icon width={17} height={17} />}
      <span>Continue with {meta.label}</span>
    </button>
  );
}

/* ------------------------------------------------------- v10 interactions */
/* Additive re-export: Tooltip, Kbd, IconButton, CopyButton, CopyField,
   Switch, ConfirmButton, Skeleton, SkeletonRows, EmptyState and ScrollTop all
   live in interactions.jsx, so `import { Tooltip } from "./ui/index.jsx"`
   keeps working alongside the existing sui-* kit above. */
export * from "./interactions.jsx";
export { default as Toaster } from "./Toaster.jsx";
export { default as CommandPalette } from "./CommandPalette.jsx";
export { PaletteTrigger, ShortcutHelp, openPalette } from "./CommandPalette.jsx";
