/* ==========================================================================
   Command palette (⌘K / Ctrl-K) + shortcut sheet (?)
   --------------------------------------------------------------------------
   One keystroke to reach any screen, any console tab, the theme switch, the
   docs or sign out — with fuzzy matching, arrow-key navigation, recent
   commands and proper combobox semantics.

   It is built from the app's own routes, so it cannot drift out of date: the
   caller passes the route table and the console tab list.
   ========================================================================== */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  MOD_LABEL,
  announce,
  fuzzyScore,
  useFocusTrap,
  useHotkeys,
  useLocalState,
} from "../../lib/ux"
import { Kbd } from "./interactions.jsx"

const RECENT_KEY = "ragestar-palette-recent"
const MAX_RECENT = 4

function go(hash) {
  if (window.location.hash === hash) {
    /* same route: still scroll back to the top so the jump feels real */
    window.scrollTo({ top: 0, behavior: "smooth" })
    return
  }
  window.location.hash = hash
}

/* ------------------------------------------------------------- the sheet */

export function ShortcutHelp({ open, onClose, extra = [] }) {
  const boxRef = useRef(null)
  useFocusTrap(open, boxRef, onClose)

  const rows = [
    { keys: ["mod", "K"], label: "Open the command palette" },
    { keys: ["/"], label: "Jump to the first search box" },
    { keys: ["G", "then", "C"], label: "Go to console" },
    { keys: ["G", "then", "A"], label: "Go to admin" },
    { keys: ["mod", "⇧", "L"], label: "Switch light / dark" },
    { keys: ["?"], label: "Show this list" },
    { keys: ["Esc"], label: "Close anything open" },
    ...extra,
  ]

  if (!open) return null

  return (
    <div className="rs-modal-scrim" onMouseDown={onClose}>
      <div
        className="rs-modal rs-keys"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={boxRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rs-modal-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="rs-modal-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <ul className="rs-keys-list">
          {rows.map((row) => (
            <li key={row.label}>
              <span className="rs-keys-label">{row.label}</span>
              <span className="rs-keys-combo">
                {row.keys.map((key, i) =>
                  key === "then" ? (
                    <em key={i}>then</em>
                  ) : (
                    <Kbd key={i} mod={key === "mod"}>
                      {key === "mod" ? "" : key}
                    </Kbd>
                  ),
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="rs-keys-foot">
          Shortcuts pause while you are typing in a field, so they never eat your input.
        </p>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- the trigger */

/* Anything in the app can open the palette by dispatching this event, so the
   button does not need a callback threaded down to it. */
export const OPEN_EVENT = "ragestar-open-palette"

export function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

/* The "search or jump to" affordance. Lives in the header so the Cmd/Ctrl+K
   layer is discoverable without a keyboard, and is finger-sized on mobile. */
export function PaletteTrigger({ onClick }) {
  return (
    <button
      type="button"
      className="rs-cmd-trigger"
      onClick={onClick || openPalette}
      aria-label="Open command palette"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="rs-cmd-trigger-text">Search or jump to…</span>
      <span className="rs-cmd-trigger-keys" aria-hidden="true">
        <Kbd mod />
        <Kbd>K</Kbd>
      </span>
    </button>
  )
}

/* ----------------------------------------------------------- the palette */

export default function CommandPalette({
  routes = [],
  consoleTabs = [],
  isAuthed = false,
  isAdmin = false,
  onToggleTheme,
  onSignOut,
  /* The trigger is styled for the header, but the palette itself is mounted
     once at the end of the tree. Set false here and render the header button
     instead, which dispatches OPEN_EVENT. */
  showTrigger = true,
}) {
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useLocalState(RECENT_KEY, [])

  const boxRef = useRef(null)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery("")
    setActive(0)
  }, [])

  useFocusTrap(open, boxRef, close)

  /* ------------------------------------------------------ command table */

  const commands = useMemo(() => {
    const list = []

    for (const route of routes) {
      if (route.hidden) continue
      if (route.adminOnly && !isAdmin) continue
      if (route.authOnly && !isAuthed) continue
      list.push({
        id: `route:${route.hash}`,
        group: "Go to",
        label: route.label,
        hint: route.hash,
        keywords: route.keywords || "",
        run: () => go(route.hash),
      })
    }

    if (isAuthed) {
      for (const tab of consoleTabs) {
        list.push({
          id: `tab:${tab.id}`,
          group: "Dashboard",
          label: tab.label,
          hint: `#/dashboard/${tab.id}`,
          keywords: `dashboard ${tab.id} ${tab.keywords || ""}`,
          run: () => go(`#/dashboard/${tab.id}`),
        })
      }
    }

    list.push({
      id: "action:theme",
      group: "Actions",
      label: "Switch light / dark theme",
      hint: `${MOD_LABEL} ⇧ L`,
      keywords: "theme dark light appearance contrast",
      run: () => onToggleTheme?.(),
    })

    list.push({
      id: "action:copy-url",
      group: "Actions",
      label: "Copy a link to this page",
      hint: "",
      keywords: "share url link copy",
      run: async () => {
        try {
          await navigator.clipboard?.writeText(window.location.href)
          announce("Link copied")
        } catch {
          announce("Copy the address from the address bar")
        }
      },
    })

    list.push({
      id: "action:shortcuts",
      group: "Actions",
      label: "Show keyboard shortcuts",
      hint: "?",
      keywords: "help keys keyboard shortcuts",
      run: () => setHelpOpen(true),
    })

    if (isAuthed) {
      list.push({
        id: "action:signout",
        group: "Actions",
        label: "Sign out",
        hint: "",
        keywords: "log out leave exit session",
        run: () => onSignOut?.(),
      })
    } else {
      list.push({
        id: "action:signin",
        group: "Actions",
        label: "Sign in",
        hint: "#/login",
        keywords: "login sign in account",
        run: () => go("#/login"),
      })
    }

    return list
  }, [routes, consoleTabs, isAuthed, isAdmin, onToggleTheme, onSignOut])

  /* ------------------------------------------------------------ matching */

  const results = useMemo(() => {
    const q = query.trim()
    if (!q) {
      const pinned = recent
        .map((id) => commands.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ ...c, group: "Recent" }))
      const rest = commands.filter((c) => !recent.includes(c.id))
      return [...pinned, ...rest].slice(0, 14)
    }
    return commands
      .map((c) => ({
        command: c,
        score: Math.max(
          fuzzyScore(c.label, q) * 2,
          fuzzyScore(`${c.keywords} ${c.hint}`, q),
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((r) => r.command)
  }, [commands, query, recent])

  useEffect(() => setActive(0), [query])

  /* keep the highlighted row in view while arrowing through the list */
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector('[data-active="true"]')
    node?.scrollIntoView({ block: "nearest" })
  }, [active, open, results.length])

  const runCommand = useCallback(
    (command) => {
      if (!command) return
      close()
      setRecent((prev) =>
        [command.id, ...prev.filter((id) => id !== command.id)].slice(0, MAX_RECENT),
      )
      /* let the palette finish closing so focus lands on the new screen */
      window.setTimeout(() => {
        command.run()
        announce(command.label)
      }, 10)
    },
    [close, setRecent],
  )

  /* ----------------------------------------------------------- hotkeys */

  const [pendingG, setPendingG] = useState(false)

  useHotkeys(
    {
      "mod+k": () => setOpen((v) => !v),
      "mod+shift+l": () => onToggleTheme?.(),
      "?": () => setHelpOpen(true),
      "shift+/": () => setHelpOpen(true),
      "/": () => {
        const field = document.querySelector(
          'input[type="search"], input[data-quick-search], .con-search input, input[placeholder*="Search" i]',
        )
        if (field) field.focus()
        else setOpen(true)
      },
      escape: () => {
        if (open) close()
        else if (helpOpen) setHelpOpen(false)
      },
      g: () => {
        setPendingG(true)
        window.setTimeout(() => setPendingG(false), 1200)
      },
      c: () => {
        if (pendingG) {
          setPendingG(false)
          go("#/console")
        }
      },
      a: () => {
        if (pendingG) {
          setPendingG(false)
          go(isAdmin ? "#/admin" : "#/console")
        }
      },
      h: () => {
        if (pendingG) {
          setPendingG(false)
          go("#/")
        }
      },
    },
    { allowInInput: false },
  )

  /* ⌘K must also work from inside a text field — that is the whole point */
  useEffect(() => {
    const onKey = (event) => {
      const isK = String(event.key).toLowerCase() === "k"
      if (isK && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  /* Lets any button anywhere in the app open the palette without having to
     thread a callback down through the tree. */
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 20)
  }, [open])

  /* lock the page behind the dialog so scrolling does not leak through */
  useEffect(() => {
    if (!open && !helpOpen) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [open, helpOpen])

  /* --------------------------------------------------------------- view */

  let lastGroup = ""

  return (
    <>
      {/* always-available hint; also the touch entry point for the palette */}
      {showTrigger ? <PaletteTrigger onClick={() => setOpen(true)} /> : null}

      {open ? (
        <div className="rs-modal-scrim rs-cmd-scrim" onMouseDown={close}>
          <div
            className="rs-cmd"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            ref={boxRef}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rs-cmd-input-row">
              <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                className="rs-cmd-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pages, tabs and actions…"
                aria-label="Search commands"
                role="combobox"
                aria-expanded="true"
                aria-controls="rs-cmd-list"
                aria-activedescendant={results[active] ? `rs-cmd-${active}` : undefined}
                autoComplete="off"
                spellCheck="false"
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault()
                    setActive((i) => (results.length ? (i + 1) % results.length : 0))
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault()
                    setActive((i) =>
                      results.length ? (i - 1 + results.length) % results.length : 0,
                    )
                  } else if (event.key === "Enter") {
                    event.preventDefault()
                    runCommand(results[active])
                  } else if (event.key === "Home") {
                    setActive(0)
                  } else if (event.key === "End") {
                    setActive(Math.max(0, results.length - 1))
                  }
                }}
              />
              <Kbd>Esc</Kbd>
            </div>

            <ul className="rs-cmd-list" id="rs-cmd-list" role="listbox" ref={listRef}>
              {results.length === 0 ? (
                <li className="rs-cmd-none">
                  Nothing matches “{query}”. Try “keys”, “credits”, “models” or “theme”.
                </li>
              ) : (
                results.map((command, index) => {
                  const header = command.group !== lastGroup ? command.group : ""
                  lastGroup = command.group
                  return (
                    <li key={command.id} className="rs-cmd-item-wrap">
                      {header ? <span className="rs-cmd-group">{header}</span> : null}
                      <div
                        id={`rs-cmd-${index}`}
                        role="option"
                        aria-selected={index === active}
                        data-active={index === active || undefined}
                        className="rs-cmd-item"
                        onMouseMove={() => setActive(index)}
                        onClick={() => runCommand(command)}
                      >
                        <span className="rs-cmd-label">{command.label}</span>
                        {command.hint ? (
                          <span className="rs-cmd-hint">{command.hint}</span>
                        ) : null}
                      </div>
                    </li>
                  )
                })
              )}
            </ul>

            <footer className="rs-cmd-foot">
              <span>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span>
                <Kbd>↵</Kbd> to open
              </span>
              <span>
                <Kbd>?</Kbd> all shortcuts
              </span>
            </footer>
          </div>
        </div>
      ) : null}

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  )
}
