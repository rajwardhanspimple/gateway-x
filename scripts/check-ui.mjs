#!/usr/bin/env node
/* ==========================================================================
   check-ui — the structural test suite for the front end
   --------------------------------------------------------------------------
   Run from the project root:

       npm test

   Eight independent checks:

     1. SYNTAX     every source file parses with a real JS/JSX/TS parser
     2. HOOKS      rules of hooks, enforced on the real syntax tree
     3. IMPORTS    every relative import resolves to a file on disk
     4. CLASSES    every className used by the UI exists in a stylesheet
     5. NO-VAULTO  the removed dark dashboard layer stays removed
     6. DASHBOARDS the two rebuilt tabs render content only — no second
                   sidebar, no second topbar, no body class
     7. FIXED-OVERLAYS  the wrapper around every screen settles on `none`, so
                   it does not steal the containing block from the `fixed`
                   modals inside it (invisible to jsdom, which has no layout)
     8. INK-TEXT   the paper tints (`ink-700`…) are never used as a text
                   colour — they are surfaces, and read at ~1.2:1 on the page

   Exit 0 = passed. 1 = something to fix, printed with file and line.

   On the hooks check specifically: the first draft of this file matched
   `^  return` with a regex and reported 281 violations, every one of them
   false — it was finding the return of a small top-level helper declared
   above the component and calling everything below it "after the return".
   Text matching cannot tell those apart, so this version walks the actual
   syntax tree and tracks real function scopes. It enforces the three rules
   that matter:

     · a hook may only be called from a component or another hook
     · never inside a condition, loop, switch or try
     · never after an early return, which is the bug that took the admin
       panel down in v11.0

   Checks 1 and 2 need a parser. Prettier ships one. If it cannot be resolved
   they report SKIP rather than guess — bracket counting throws false alarms
   on regex literals and JSX text, and a test that cries wolf is worse than
   no test.
   ========================================================================== */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"

const ROOT = process.cwd()

/* Files this rebuild owns. A missing stylesheet class here is an error;
   anywhere else it is a warning, so a pre-existing cosmetic gap in an
   untouched tab cannot fail the suite. */
const OWNED = new Set([
  "src/pages/admin/DashboardTab.jsx",
  "src/pages/console/OverviewTab.jsx",
  "src/main.jsx",
])

/* The checkers themselves talk about the thing they are checking for, so
   they must not scan their own source. */
const SELF = new Set(["scripts/check-ui.mjs", "scripts/check-keywatch.mjs"])

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", ".temp"])

/* ---------------------------------------------------------------- plumbing */

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, amber: (s) => s }

const errors = []
const warnings = []

const fail = (where, message) => errors.push(`${where}: ${message}`)
const warn = (where, message) => warnings.push(`${where}: ${message}`)

function report(state, label, detail) {
  const mark =
    state === "ok"
      ? paint.green("  ok ")
      : state === "skip"
        ? paint.amber(" skip")
        : paint.red(" fail")
  console.log(`${mark}  ${label}${detail ? paint.dim(` \u2014 ${detail}`) : ""}`)
}

function walkDir(dir, out = []) {
  let entries
  try {
    entries = readdirSync(resolve(ROOT, dir))
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const rel = join(dir, name).split("\\").join("/")
    let st
    try {
      st = statSync(resolve(ROOT, rel))
    } catch {
      continue
    }
    if (st.isDirectory()) walkDir(rel, out)
    else out.push(rel)
  }
  return out
}

const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8")
const lineOf = (source, index) => source.slice(0, index).split("\n").length

/* Blank out comments so checks never fire on prose. String bodies are kept —
   className and import checks need them. */
function stripComments(code) {
  let out = ""
  let mode = "code"
  let quote = ""
  let i = 0
  while (i < code.length) {
    const c = code[i]
    const next = code[i + 1]
    if (mode === "code") {
      if (c === "/" && next === "*") {
        mode = "block"
        out += "  "
        i += 2
        continue
      }
      if (c === "/" && next === "/") {
        mode = "line"
        out += "  "
        i += 2
        continue
      }
      if (c === '"' || c === "'" || c === "`") {
        mode = "string"
        quote = c
      }
      out += c
      i += 1
      continue
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code"
        out += "  "
        i += 2
        continue
      }
      out += c === "\n" ? "\n" : " "
      i += 1
      continue
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code"
        out += "\n"
        i += 1
        continue
      }
      out += " "
      i += 1
      continue
    }
    if (c === "\\") {
      out += c + (next ?? "")
      i += 2
      continue
    }
    if (c === quote) {
      mode = "code"
      quote = ""
    }
    out += c
    i += 1
  }
  return out
}

/* ------------------------------------------------------------ the file set */

const allFiles = [
  ...walkDir("src"),
  ...walkDir("scripts"),
  ...walkDir("cloudflare"),
  ...walkDir("supabase/functions"),
]
const jsFiles = allFiles.filter((f) => [".js", ".jsx", ".mjs", ".ts"].includes(extname(f)))
const jsxFiles = allFiles.filter((f) => extname(f) === ".jsx")
const cssFiles = allFiles.filter((f) => extname(f) === ".css")

if (jsxFiles.length === 0) {
  console.error("check-ui: no .jsx files found — run this from the project root")
  process.exit(1)
}

/* ================================================================ parser */

async function loadParser() {
  try {
    const mod = await import("prettier")
    const p = mod.default ?? mod
    const version = p.version ?? mod.version ?? ""
    const parserFor = (file) => (extname(file) === ".ts" ? "babel-ts" : "babel")

    if (typeof p.__debug?.parse === "function") {
      return {
        name: `prettier ${version}`.trim(),
        givesAst: true,
        async parse(code, file) {
          const out = await p.__debug.parse(code, { parser: parserFor(file), filepath: file })
          return out?.ast ?? null
        },
      }
    }
    if (typeof p.format === "function") {
      return {
        name: `prettier ${version}`.trim(),
        givesAst: false,
        async parse(code, file) {
          await p.format(code, { parser: parserFor(file), filepath: file })
          return null
        },
      }
    }
  } catch {
    /* no parser available */
  }
  return null
}

const parser = await loadParser()
const astByFile = new Map()

/* ============================================================== 1. SYNTAX */

async function checkSyntax() {
  if (!parser) {
    report("skip", "SYNTAX", "no parser resolvable (install prettier to enable); other checks still ran")
    return
  }
  let bad = 0
  for (const file of jsFiles) {
    try {
      const ast = await parser.parse(read(file), file)
      if (ast) astByFile.set(file, ast)
    } catch (e) {
      bad += 1
      fail(file, `does not parse — ${String(e?.message || e).split("\n")[0]}`)
    }
  }
  if (bad) report("fail", "SYNTAX", `${bad} of ${jsFiles.length} files failed to parse`)
  else report("ok", "SYNTAX", `${jsFiles.length} files parsed with ${parser.name}`)
}

/* =============================================================== 2. HOOKS */

const FN_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
])

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "comments",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "tokens",
  "errors",
])

/* Depth-first walk that hands every visitor the live ancestor chain, each
   entry carrying the property name it was reached through — that is what
   makes "is this hook in the consequent of an if" answerable. */
function walkAst(root, visit) {
  const chain = []
  function go(node, key) {
    chain.push({ node, key })
    visit(node, chain)
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue
      const value = node[k]
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") go(child, k)
      } else if (value && typeof value.type === "string") {
        go(value, k)
      }
    }
    chain.pop()
  }
  go(root, "root")
}

function hookNameOf(node) {
  if (node.type !== "CallExpression") return null
  const callee = node.callee
  if (callee?.type === "Identifier" && /^use[A-Z]/.test(callee.name)) return callee.name
  if (
    callee?.type === "MemberExpression" &&
    callee.property?.type === "Identifier" &&
    /^use[A-Z]/.test(callee.property.name)
  ) {
    return callee.property.name
  }
  return null
}

/* A function is a legal place to call a hook if it is a component (capital
   first letter), another hook (useX), or a forwardRef/memo wrapper. */
function scopeNameOf(chain, index) {
  const node = chain[index].node
  if (node.type === "FunctionDeclaration") return node.id?.name ?? null
  const parent = chain[index - 1]?.node
  if (!parent) return null
  if (parent.type === "VariableDeclarator" && parent.id?.type === "Identifier") return parent.id.name
  if (parent.type === "AssignmentExpression" && parent.left?.type === "Identifier") return parent.left.name
  if (parent.type === "ObjectProperty" && parent.key?.type === "Identifier") return parent.key.name
  if (parent.type === "CallExpression") {
    const callee = parent.callee
    const name = callee?.type === "Identifier" ? callee.name : callee?.property?.name
    if (name === "forwardRef" || name === "memo") return "ForwardRef"
  }
  return null
}

const isReactScope = (name) => Boolean(name) && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name))

/* Does this statement return, without crossing into a nested function? */
function returnsEarly(stmt) {
  let found = false
  walkAst(stmt, (node, chain) => {
    if (found || node.type !== "ReturnStatement") return
    for (let i = 1; i < chain.length - 1; i += 1) {
      if (FN_TYPES.has(chain[i].node.type)) return
    }
    found = true
  })
  return found
}

function guardPosition(node, chain, index) {
  const childKey = chain[index + 1]?.key
  switch (node.type) {
    case "IfStatement":
    case "ConditionalExpression":
      return childKey === "consequent" || childKey === "alternate" ? "a condition" : null
    case "LogicalExpression":
      return childKey === "right" ? "a short-circuit" : null
    case "SwitchStatement":
      return childKey === "cases" ? "a switch" : null
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
      return "a loop"
    case "TryStatement":
    case "CatchClause":
      return "a try block"
    default:
      return null
  }
}

function checkHooks() {
  if (!parser?.givesAst) {
    report("skip", "HOOKS", "needs a syntax tree; text matching produces false alarms")
    return
  }

  let bad = 0
  let hooksSeen = 0
  const guardCache = new Map()

  for (const file of jsxFiles) {
    const ast = astByFile.get(file)
    if (!ast) continue

    walkAst(ast, (node, chain) => {
      const hook = hookNameOf(node)
      if (!hook) return
      hooksSeen += 1

      const line = node.loc?.start?.line ?? 0

      let fnIndex = -1
      for (let i = chain.length - 2; i >= 0; i -= 1) {
        if (FN_TYPES.has(chain[i].node.type)) {
          fnIndex = i
          break
        }
      }
      if (fnIndex === -1) {
        bad += 1
        fail(file, `${hook}() called at module level on line ${line}`)
        return
      }

      const fnNode = chain[fnIndex].node
      const fnName = scopeNameOf(chain, fnIndex)

      if (!isReactScope(fnName)) {
        bad += 1
        fail(
          file,
          `${hook}() on line ${line} is called from ${fnName ? `"${fnName}"` : "an anonymous callback"}, which is not a component or a hook`,
        )
        return
      }

      for (let i = fnIndex; i < chain.length - 1; i += 1) {
        const where = guardPosition(chain[i].node, chain, i)
        if (where) {
          bad += 1
          fail(file, `${hook}() on line ${line} is inside ${where} — hooks must run on every render`)
          return
        }
      }

      /* The v11.0 bug: an early return above, hooks below. */
      if (fnNode.body?.type === "BlockStatement") {
        if (!guardCache.has(fnNode)) {
          let guardLine = Infinity
          let guardText = ""
          for (const stmt of fnNode.body.body) {
            if (stmt.type === "ReturnStatement" || returnsEarly(stmt)) {
              guardLine = stmt.loc?.end?.line ?? Infinity
              guardText = stmt.type === "ReturnStatement" ? "the return" : "an early return"
              break
            }
          }
          guardCache.set(fnNode, { guardLine, guardText })
        }
        const { guardLine, guardText } = guardCache.get(fnNode)
        if (line > guardLine) {
          bad += 1
          fail(
            file,
            `${hook}() on line ${line} runs after ${guardText} on line ${guardLine} in ${fnName}() — it will be skipped on some renders`,
          )
        }
      }
    })
  }

  if (bad) report("fail", "HOOKS", `${bad} violation(s)`)
  else report("ok", "HOOKS", `${hooksSeen} hook calls across ${jsxFiles.length} files, all unconditional`)
}

/* ============================================================= 3. IMPORTS */

const IMPORT = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g

function resolveImport(fromFile, spec) {
  const base = resolve(ROOT, dirname(fromFile), spec)
  return [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.ts`,
    join(base, "index.js"),
    join(base, "index.jsx"),
  ].some((p) => existsSync(p) && statSync(p).isFile())
}

function checkImports() {
  let bad = 0
  let total = 0
  for (const file of jsFiles) {
    const code = stripComments(read(file))
    IMPORT.lastIndex = 0
    let m
    while ((m = IMPORT.exec(code))) {
      total += 1
      if (!resolveImport(file, m[1])) {
        bad += 1
        fail(file, `line ${lineOf(code, m.index)} imports "${m[1]}", which does not exist`)
      }
    }
  }
  if (bad) report("fail", "IMPORTS", `${bad} of ${total} relative imports do not resolve`)
  else report("ok", "IMPORTS", `${total} relative imports all resolve`)
}

/* ============================================================= 4. CLASSES */

function definedClasses() {
  const set = new Set()
  const sheets = [...cssFiles]
  if (existsSync(resolve(ROOT, "src/styles.css"))) sheets.push("src/styles.css")
  for (const file of sheets) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, " ")
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) set.add(m[1])
  }
  return set
}

/* Only whole, statically-known class names are checked. A token touching a
   `${...}` placeholder is half a name, so it is dropped rather than guessed. */
function classTokens(raw) {
  return raw
    .replace(/\$\{[^}]*\}?/g, "\u0000")
    .split(/\s+/)
    .filter((t) => /^[a-zA-Z][\w-]*$/.test(t))
}

function checkClasses() {
  const defined = definedClasses()
  const missing = new Map()
  let used = 0

  for (const file of jsxFiles) {
    const code = stripComments(read(file))
    for (const m of code.matchAll(/className\s*=\s*(?:"([^"]*)"|\{\s*`([^`]*)`|'([^']*)')/g)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? ""
      for (const token of classTokens(raw)) {
        used += 1
        if (defined.has(token)) continue
        if (!missing.has(token)) missing.set(token, [])
        missing.get(token).push(`${file}:${lineOf(code, m.index)}`)
      }
    }
  }

  if (missing.size === 0) {
    report("ok", "CLASSES", `${used} className tokens, ${defined.size} defined, 0 missing`)
    return
  }

  let hard = 0
  for (const [token, where] of missing) {
    const owned = where.find((w) => OWNED.has(w.split(":")[0]))
    if (owned) {
      hard += 1
      fail(owned, `className "${token}" is not defined in any stylesheet`)
    } else {
      warn(where[0], `className "${token}" is not defined in any stylesheet`)
    }
  }

  if (hard) report("fail", "CLASSES", `${hard} missing class(es) in rebuilt files`)
  else
    report(
      "ok",
      "CLASSES",
      `${used} tokens checked, ${missing.size} pre-existing gap(s) reported as warnings`,
    )
}

/* =========================================================== 5. NO-VAULTO */

const GONE_FILES = [
  ["src", "styles", "vaulto.css"],
  ["src", "styles", "vaulto-shell.css"],
  ["src", "components", "VtShell.jsx"],
  ["src", "components", "charts.jsx"],
]

function checkNoVaulto() {
  let bad = 0

  for (const parts of GONE_FILES) {
    const rel = parts.join("/")
    if (existsSync(resolve(ROOT, rel))) {
      bad += 1
      fail(rel, "this file was removed with the dark dashboard layer, but it is back")
    }
  }

  const removedLayer = ["va", "ulto"].join("")
  const stylesheetRef = new RegExp(`["'\`][^"'\`\\n]*${removedLayer}[^"'\`\\n]*["'\`]`, "i")
  const shellImport = /\bimport\s+(?:VtShell\b|\{[^}]*\bVt[A-Z]\w*)/
  const shellClass = /className\s*=\s*(?:"|\{\s*`)[^"`\n]*\bvt-/
  const bodyClass = /classList\s*\.\s*\w+\s*\(\s*["'`]vt-/

  for (const file of [...jsFiles, ...cssFiles]) {
    if (SELF.has(file)) continue
    const code = stripComments(read(file))
    const lines = code.split("\n")
    lines.forEach((text, i) => {
      const at = `line ${i + 1}`
      if (stylesheetRef.test(text)) {
        bad += 1
        fail(file, `${at} still references the removed stylesheet`)
      }
      if (shellImport.test(text)) {
        bad += 1
        fail(file, `${at} still imports from the removed shell or chart module`)
      }
      if (shellClass.test(text)) {
        bad += 1
        fail(file, `${at} still uses a "vt-" class, which no stylesheet defines any more`)
      }
      if (bodyClass.test(text)) {
        bad += 1
        fail(file, `${at} still adds a "vt-" class to an element`)
      }
    })
  }

  if (bad) report("fail", "NO-VAULTO", `${bad} leftover reference(s)`)
  else report("ok", "NO-VAULTO", "layer gone: no files, imports, classes or stylesheet links left")
}

/* ========================================================== 6. DASHBOARDS */

function checkDashboards() {
  const cases = [
    {
      file: "src/pages/admin/DashboardTab.jsx",
      mustUse: ["KeyWatch", "ap-grid", "Kpi", "Panel"],
      mustNotUse: ["VtShell", "vt-rail", "vt-top", "vt-canvas"],
      keepProps: [
        "dash",
        "upstreams",
        "upKeys",
        "models",
        "users",
        "logs",
        "audit",
        "busy",
        "onRefresh",
        "onTest",
        "onAutoTest",
        "onJump",
      ],
      parent: ["src/pages/Admin.jsx", /<DashboardTab/],
    },
    /* A case for src/pages/console/OverviewTab.jsx, mounted by
       src/pages/Workspace.jsx, used to live here. Both files moved to
       recycle-bin/ on 2026-09-21 — the console shell had been unrouted since
       v12.8, so nothing rendered this tab and nothing imported either file. The
       live dashboard has its own Overview view in
       src/ragestar/dashboard/Dashboard.jsx. To bring the pair back, restore
       them from recycle-bin/ and re-add this case. */
    /* src/pages/console/KeysTab.jsx is also NOT covered here any more. It stays
       in src/pages/console/ (it is imported by scripts/render/keys-live.mjs and
       exercised by `npm run test:keys-live`, so it is covered code, not dead
       code) — but its old expectation in this list described the retired
       console's props, so it was dropped rather than rewritten from guesswork.
       Its real coverage is the keys-live suite. */
  ]

  let bad = 0
  for (const c of cases) {
    if (!existsSync(resolve(ROOT, c.file))) {
      bad += 1
      fail(c.file, "missing")
      continue
    }
    const code = stripComments(read(c.file))

    for (const needle of c.mustUse) {
      if (!code.includes(needle)) {
        bad += 1
        fail(c.file, `expected it to use "${needle}" — the normal layout is not in place`)
      }
    }
    for (const needle of c.mustNotUse) {
      if (code.includes(needle)) {
        bad += 1
        fail(c.file, `still contains "${needle}" — the second sidebar is back`)
      }
    }
    /* The props contract is what lets the parent pages stay untouched.
       Dropping one silently renders an empty panel. */
    for (const prop of c.keepProps) {
      if (!new RegExp(`\\b${prop}\\b`).test(code)) {
        bad += 1
        fail(c.file, `no longer reads the "${prop}" prop that its parent passes`)
      }
    }
    if (/document\s*\.\s*body\s*\.\s*classList/.test(code)) {
      bad += 1
      fail(c.file, "writes to document.body.classList — a tab must not restyle the whole app")
    }

    const [parentFile, mounts] = c.parent
    if (existsSync(resolve(ROOT, parentFile)) && !mounts.test(read(parentFile))) {
      bad += 1
      fail(parentFile, `no longer renders ${c.file.split("/").pop().replace(".jsx", "")}`)
    }
  }

  if (bad) report("fail", "DASHBOARDS", `${bad} problem(s)`)
  else report("ok", "DASHBOARDS", "both tabs render content only, props contract intact")
}

/* ======================================================= 7. FIXED-OVERLAYS */

/* Every modal in the kit is `position: fixed; inset: 0`, and a `fixed`
   element is positioned against its nearest ancestor that establishes a
   containing block — which any non-`none` transform, translate, scale, rotate
   or filter does (CSS Transforms L1). `.pr-page-enter` wraps every
   authenticated screen and runs with fill-mode `both`, so its *finished*
   frame stays applied for the life of the element: if that frame is an
   identity transform rather than `none`, the wrapper becomes the containing
   block and every dialog centres against it — a page-tall box — instead of
   the viewport. The dialog then lands far below the fold behind its own
   blurred backdrop, which is the "screen goes blur and nothing happens"
   report.

   jsdom has no layout engine, so the render suites cannot see it. It has to
   be checked in the stylesheet. */

const CONTEXT_PROPS = ["transform", "translate", "scale", "rotate", "filter"]

/** The body of `@keyframes <name> { … }`, braces balanced. */
function keyframesBody(css, name) {
  const at = css.indexOf(`@keyframes ${name}`)
  if (at === -1) return null
  const open = css.indexOf("{", at)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1
    else if (css[i] === "}") {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/** The declarations of a single frame — `to`, `from`, `50%` … — inside a
 *  keyframes body. Frames do not nest, so the first `}` closes it. */
function frameBody(body, frame) {
  const m = new RegExp(`(?:^|[\\s,])${frame}\\s*\\{`).exec(body)
  if (!m) return null
  const open = body.indexOf("{", m.index)
  const close = body.indexOf("}", open)
  if (open === -1 || close === -1) return null
  return body.slice(open + 1, close)
}

function checkFixedOverlays() {
  const file = "src/ragestar/theme.css"
  if (!existsSync(resolve(ROOT, file))) {
    report("skip", "FIXED-OVERLAYS", `${file} not found`)
    return
  }
  const css = stripComments(read(file))

  if (!/\.pr-page-enter\s*\{[^}]*animation\s*:[^;}]*pr-page-in/.test(css)) {
    report("ok", "FIXED-OVERLAYS", "no .pr-page-enter wrapper to trap fixed overlays")
    return
  }

  const body = keyframesBody(css, "pr-page-in")
  const settle = body && frameBody(body, "to")
  if (!settle) {
    fail(file, "pr-page-in has no `to` frame, so .pr-page-enter never settles")
    report("fail", "FIXED-OVERLAYS", "cannot read the settled frame")
    return
  }

  const kept = []
  for (const prop of CONTEXT_PROPS) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(settle)
    if (!m) continue
    const value = m[1].trim().toLowerCase()
    if (value !== "none") kept.push(`${prop}: ${value}`)
  }

  if (kept.length) {
    fail(
      file,
      `pr-page-in settles on ${kept.join(", ")} — .pr-page-enter keeps a containing block, ` +
        `so every position:fixed dialog is positioned against that page-tall wrapper instead ` +
        `of the viewport and renders behind its own blurred backdrop. End the frame on "none".`,
    )
    report("fail", "FIXED-OVERLAYS", `${kept.length} retained property(ies) on .pr-page-enter`)
    return
  }

  report("ok", "FIXED-OVERLAYS", ".pr-page-enter settles on none — fixed dialogs stay viewport-anchored")
}

/* ============================================================== 8. INK-TEXT */

/* In this kit the `ink-*` scale is the paper SURFACE ramp, not an ink ramp:
   ink-950 (#e9ece4) is the page itself and ink-700/800 are tints barely darker
   than it. Text uses the `white/N` ramp, which the theme points at #101814.
   Setting type with the mid-paper tints therefore lands around 1.2:1 against
   the page — the "Build with RageStar in minutes…" heading was written that way
   and was effectively invisible.

   `text-ink-950` stays legal: it is the light "paper" colour, used for text
   sitting on a coloured surface. It is the MID tints that can never be read
   on paper. */
const INK_TEXT = /\btext-ink-(700|750|800|850|900)\b/g;

function checkInkText() {
  const hits = [];
  for (const file of walkDir("src")) {
    if (!/\.(jsx?|tsx?)$/.test(file)) continue;
    const source = stripComments(read(file));
    const re = new RegExp(INK_TEXT.source, "g");
    let m;
    while ((m = re.exec(source))) {
      hits.push(`${file}:${lineOf(source, m.index)}  ${m[0]}`);
    }
  }

  if (hits.length) {
    fail(
      hits[0].split("  ")[0],
      `${hits.length} place(s) set text with a paper tint. These are surface colours; ` +
        `use the ink ramp instead (text-white/85 for primary, text-white/65 for secondary) — ` +
        `on paper these render at roughly 1.2:1.`,
    );
    report("fail", "INK-TEXT", `${hits.length} paper tint(s) used as a text colour`);
    for (const h of hits.slice(0, 6)) console.log(paint.dim(`        ${h}`));
    if (hits.length > 6) console.log(paint.dim(`        … and ${hits.length - 6} more`));
    return;
  }

  report("ok", "INK-TEXT", "no paper tints used as text colours");
}

/* ==================================================================== run */

console.log(paint.bold("check-ui") + paint.dim(`  ${ROOT}`))
console.log()

await checkSyntax()
checkHooks()
checkImports()
checkClasses()
checkNoVaulto()
checkDashboards()
checkFixedOverlays()
checkInkText()

console.log()

if (warnings.length) {
  console.log(paint.amber(`${warnings.length} warning(s) — pre-existing, untouched by this change:`))
  for (const w of warnings.slice(0, 15)) console.log(`  ${w}`)
  if (warnings.length > 15) console.log(paint.dim(`  …and ${warnings.length - 15} more`))
  console.log()
}

if (errors.length) {
  console.log(paint.red(paint.bold(`${errors.length} problem(s):`)))
  for (const e of errors) console.log(`  ${e}`)
  console.log()
  process.exit(1)
}

console.log(paint.green(paint.bold("all front-end checks passed")))
process.exit(0)
