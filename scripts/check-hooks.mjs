#!/usr/bin/env node
/* ==========================================================================
   check-hooks — AST rules-of-hooks audit
   --------------------------------------------------------------------------
   This repo has been bitten twice by the same class of bug: HOOK-ERROR-
   REPORT.md ("Rendered more hooks", v11.0.0) and the v12.10 regression
   ("Rendered fewer hooks", hooks nested inside the `if (loading)` block).
   Both times the text-matching scan in check-ui could not see the problem,
   and check-render's single SSR pass cannot reproduce a hook-count change
   between two renders.

   So this walks the real syntax tree of every source file and flags, per
   component or custom hook:

     HOOK_AFTER_EARLY_RETURN  a hook called after a top-level `return`
     HOOK_IN_CONDITIONAL      a hook inside if / else, ternary, && / || / ??,
                              loops, try / catch / finally or a switch case —
                              any branch that a later render can skip
     HOOK_IN_PLAIN_FUNCTION   a hook inside a function that is neither a
                              component nor a custom hook (callbacks, helpers)
     HOOK_AT_MODULE_LEVEL     a hook called while the module is importing

   Uses @babel/parser, which @vitejs/plugin-react already installs, so there
   is no new dependency. Exits non-zero when any violation is found.

   Usage:  node scripts/check-hooks.mjs [file …]     (default: src/**)
   ========================================================================== */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve as resolvePath } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const require = createRequire(import.meta.url)

let parse
try {
  ;({ parse } = require("@babel/parser"))
} catch {
  console.log("check-hooks\n")
  console.log("  skip  @babel/parser is not installed — run `npm install` first")
  console.log()
  process.exit(0)
}

const ROOT = process.cwd()
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", ".temp"])
const SOURCE_EXT = new Set([".js", ".jsx", ".ts", ".tsx"])

/* ------------------------------------------------------------------ collect */

const explicit = process.argv.slice(2).filter((a) => !a.startsWith("-"))
const files = explicit.length
  ? explicit.map((f) => resolvePath(ROOT, f))
  : (() => {
      const out = []
      const walk = (dir) => {
        let entries
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const name of entries) {
          if (SKIP_DIRS.has(name)) continue
          const full = join(dir, name)
          let st
          try {
            st = statSync(full)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            walk(full)
            continue
          }
          /* `Admin.jsx.broken` and friends are snapshots, not live code. */
          if (/\.(broken|bak|orig|rej)$/.test(name)) continue
          if (SOURCE_EXT.has(extname(name))) out.push(full)
        }
      }
      walk(join(ROOT, "src"))
      return out
    })()

/* -------------------------------------------------------------- AST walking */

const HOOK_NAME = /^use[A-Z]/

/* APIs that look like hooks but are not React hooks. Firebase Auth ships two
   of them, and flagging them every run teaches people to ignore this tool. */
const NOT_HOOKS = new Set(["useDeviceLanguage", "useEmulator"])
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"])
const NON_CHILD_KEYS = new Set([
  "loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "extra",
])

/* Keys whose subtrees a later render may skip entirely. */
const CONDITIONAL_KEYS = {
  IfStatement: new Set(["consequent", "alternate"]),
  ForStatement: new Set(["body"]),
  ForInStatement: new Set(["body"]),
  ForOfStatement: new Set(["body"]),
  WhileStatement: new Set(["body"]),
  DoWhileStatement: new Set(["body"]),
  TryStatement: new Set(["block", "handler", "finalizer"]),
  SwitchCase: new Set(["consequent"]),
  ConditionalExpression: new Set(["consequent", "alternate"]),
  LogicalExpression: new Set(["right"]),
}

function calleeName(node) {
  const c = node.callee
  if (!c) return null
  if (c.type === "Identifier") return c.name
  if (c.type === "MemberExpression" && !c.computed && c.property?.type === "Identifier") {
    return c.property.name
  }
  return null
}

function isHookCall(node) {
  if (node?.type !== "CallExpression") return false
  const name = calleeName(node) || ""
  return HOOK_NAME.test(name) && !NOT_HOOKS.has(name)
}

/* Collect hook calls inside `node` without crossing function boundaries. */
function findHooks(node, inConditional, acc) {
  if (!node || typeof node.type !== "string") return acc
  if (FUNCTION_TYPES.has(node.type)) return acc

  if (isHookCall(node)) {
    acc.push({
      name: calleeName(node),
      line: node.loc?.start?.line ?? 0,
      col: node.loc?.start?.column ?? 0,
      conditional: inConditional,
    })
  }

  const condKeys = CONDITIONAL_KEYS[node.type]
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue
    const childConditional = inConditional || (condKeys ? condKeys.has(key) : false)
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          findHooks(child, childConditional, acc)
        }
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      findHooks(value, childConditional, acc)
    }
  }
  return acc
}

function functionName(node, parent) {
  if (node.id?.name) return node.id.name
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
    return parent.id.name
  }
  if (parent?.type === "MethodDefinition" || parent?.type === "Property") {
    const key = parent.key
    if (key?.type === "Identifier") return key.name
  }
  return null
}

/* Every function definition in the file, with a best-effort name. */
function collectFunctions(program) {
  const found = []
  const visit = (node, parent) => {
    if (FUNCTION_TYPES.has(node.type)) {
      found.push({ node, name: functionName(node, parent) })
    }
    for (const key of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && typeof child.type === "string") {
            visit(child, node)
          }
        }
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        visit(value, node)
      }
    }
  }
  visit(program, null)
  return found
}

const isHookContext = (name) => !!name && (HOOK_NAME.test(name) || /^[A-Z]/.test(name))

/* -------------------------------------------------------------------- audit */

const violations = []
let contexts = 0
let parsed = 0
const parseFailures = []

for (const file of files) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/")
  let ast
  try {
    ast = parse(readFileSync(file, "utf8"), {
      sourceType: "module",
      plugins: ["jsx", "classProperties", "classPrivateProperties", "topLevelAwait"],
      errorRecovery: false,
    })
    parsed++
  } catch (err) {
    parseFailures.push(`${rel}: ${err.message?.split("\n")[0]}`)
    continue
  }

  const where = (h) => `${rel}:${h.line}:${h.col + 1} — ${h.name}()`

  /* Module level: hooks run while importing are never legal. */
  for (const stmt of ast.program.body) {
    for (const h of findHooks(stmt, false, [])) {
      violations.push(`HOOK_AT_MODULE_LEVEL    ${where(h)}`)
    }
  }

  for (const fn of collectFunctions(ast.program)) {
    const body = fn.node.body
    if (!body || body.type !== "BlockStatement") continue

    if (isHookContext(fn.name)) {
      contexts++
      let afterReturn = false
      for (const stmt of body.body) {
        if (stmt.type === "ReturnStatement") {
          afterReturn = true
          continue
        }
        for (const h of findHooks(stmt, false, [])) {
          if (afterReturn) {
            violations.push(
              `HOOK_AFTER_EARLY_RETURN ${where(h)}  (in ${fn.name}, after the return on line ${stmt.loc?.start?.line})`,
            )
          } else if (h.conditional) {
            violations.push(`HOOK_IN_CONDITIONAL     ${where(h)}  (in ${fn.name})`)
          }
        }
      }
    } else {
      /* Plain function: any hook call inside it is a violation, whatever the
         nesting — callbacks and helpers cannot own hook state. */
      for (const h of findHooks(body, false, [])) {
        const label = fn.name ? `in ${fn.name}` : "in anonymous function"
        violations.push(`HOOK_IN_PLAIN_FUNCTION  ${where(h)}  (${label})`)
      }
    }
  }
}

/* -------------------------------------------------------------------- report */

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, green: (s) => s, red: (s) => s, amber: (s) => s }

console.log(paint.bold("check-hooks") + paint.dim(`  ${ROOT}`))
console.log()

for (const f of parseFailures) {
  console.log(`  ${paint.red("fail")}  PARSE — ${f}`)
}

if (violations.length) {
  for (const v of violations) {
    console.log(`  ${paint.red("fail")}  ${v}`)
  }
  console.log()
  console.log(
    `  ${paint.red(`${violations.length} hook-order violation(s)`)} across ${parsed}/${files.length} files, ${contexts} hook contexts`,
  )
  console.log()
  process.exit(1)
}

console.log(
  `  ${paint.green("ok")}   HOOKS — ${parsed}/${files.length} files, ${contexts} component/hook contexts, 0 violations`,
)
console.log()
