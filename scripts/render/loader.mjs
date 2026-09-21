/* ==========================================================================
   Module hooks for the render test
   --------------------------------------------------------------------------
   Lets the real components be imported outside a browser and outside Vite,
   with three narrow substitutions and nothing else:

     1. `firebase/*` and `@supabase/supabase-js` are replaced by permissive
        stubs. Neither package is needed to draw a dashboard, and the render
        test must not open a network connection.
     2. `import.meta.env` becomes a plain object. Vite rewrites that at build
        time; node has never heard of it.
     3. `.jsx` is transformed, either by tsx if it is installed or by the
        esbuild that already ships inside Vite.

     3. `.jsx` is transformed, either by tsx if it is installed or by the
        esbuild that already ships inside Vite.

   Everything else resolves and loads normally, so the code under test is the
   real code — same imports, same helpers, same components.

   One escape hatch: RENDER_STUB_MAP can name a JSON file that swaps a single
   project module for a test double, e.g.

     { "src/ragestar/lib/workspace.js": "scripts/render/stubs/workspace-live.js" }

   That is how a harness drives one screen's data layer directly instead of
   waiting on the (stubbed, opaque) network layer. Paths are relative to the
   project root; the double is loaded and transformed exactly like the real
   file, so it can be JSX and can import project code.
   ========================================================================== */

import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readdirSync } from "node:fs"

const STUB_SCHEME = "render-stub:"
const STUBBED = [/^firebase(\/.*)?$/, /^@supabase\/supabase-js$/]
const TRANSFORMABLE = new Set([".jsx", ".tsx", ".ts"])
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".wrangler", ".temp"])

let root = process.cwd()
let transform = "none"
let stubs = new Map()
let esbuild = null
let moduleDoubles = new Map()

const isStubbed = (spec) => STUBBED.some((re) => re.test(spec))

/* ------------------------------------------------------------------ stubs */

/* The stub for a package has to export exactly the names the project asks
   for, because ESM checks named imports before any code runs. Rather than
   hard-code a list that silently rots, scan the source for what it imports. */
function collectImportedNames(dir, found) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found
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
      collectImportedNames(full, found)
      continue
    }
    if (![".js", ".jsx", ".ts", ".tsx", ".mjs"].includes(extname(name))) continue

    const code = readFileSync(full, "utf8")
    for (const m of code.matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1]
      if (!isStubbed(spec)) continue

      /* Walk back to the `import` that owns this `from` so multi-line
         clauses are captured whole. */
      const head = code.slice(0, m.index)
      const at = head.lastIndexOf("import")
      const clause = at === -1 ? "" : head.slice(at + 6)

      if (!found.has(spec)) found.set(spec, new Set())
      const names = found.get(spec)
      const braced = clause.match(/\{([\s\S]*)\}/)
      if (braced) {
        for (const piece of braced[1].split(",")) {
          const name = piece.trim().split(/\s+as\s+/)[0].trim()
          if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== "default") names.add(name)
        }
      }
    }
  }
  return found
}

function stubSource(names) {
  const exports = [...names].map((n) => `export const ${n} = make();`).join("\n")
  return `/* stub — render test only, never bundled */
const handler = {
  get(target, prop) {
    if (prop === Symbol.toPrimitive) return () => "";
    if (prop === "then") return undefined;
    if (typeof prop === "symbol") return undefined;
    if (prop === "length") return 0;
    if (prop === "name") return "stub";
    return make();
  },
  apply() { return make(); },
  construct() { return make(); },
};
function make() { return new Proxy(function stub() {}, handler); }
${exports}
export default make();
`
}

function buildStubs() {
  const found = collectImportedNames(resolvePath(root, "src"), new Map())
  const out = new Map()
  for (const [spec, names] of found) out.set(spec, stubSource(names))
  /* A package imported only for its side effects still needs a module. */
  for (const spec of ["firebase/app", "firebase/auth", "@supabase/supabase-js"]) {
    if (!out.has(spec)) out.set(spec, stubSource(new Set()))
  }
  return out
}

/* ------------------------------------------------------------------ hooks */

/* Absolute path -> absolute path of the file that should stand in for it. */
function buildModuleDoubles() {
  const file = process.env.RENDER_STUB_MAP
  if (!file) return new Map()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (err) {
    console.warn(`loader: could not read RENDER_STUB_MAP (${file}): ${err.message}`)
    return new Map()
  }
  const out = new Map()
  for (const [target, double] of Object.entries(parsed)) {
    const from = resolvePath(root, target)
    const to = resolvePath(root, double)
    if (!existsSync(to)) {
      console.warn(`loader: module double missing (${to}) — ignoring rule for ${target}`)
      continue
    }
    out.set(from, to)
  }
  return out
}

export async function initialize(data) {
  root = data?.root || process.cwd()
  transform = data?.transform || "none"
  stubs = buildStubs()
  moduleDoubles = buildModuleDoubles()

  if (transform === "esbuild") {
    try {
      const vite = await import("vite")
      if (typeof vite.transformWithEsbuild === "function") {
        esbuild = async (code, file) => {
          const out = await vite.transformWithEsbuild(code, file, {
            loader: extname(file) === ".ts" ? "ts" : "jsx",
            jsx: "automatic",
          })
          return out.code
        }
        return
      }
    } catch {
      /* fall through to esbuild proper */
    }
    const mod = await import("esbuild")
    esbuild = async (code, file) => {
      const out = await mod.transform(code, {
        loader: extname(file) === ".ts" ? "ts" : "jsx",
        jsx: "automatic",
      })
      return out.code
    }
  }
}

export async function resolve(specifier, context, next) {
  if (isStubbed(specifier)) {
    return { url: STUB_SCHEME + specifier, format: "module", shortCircuit: true }
  }
  try {
    return await next(specifier, context)
  } catch (err) {
    /* Vite lets an import omit its extension; node does not. */
    if (transform !== "esbuild" || !specifier.startsWith(".")) throw err
    const base = fileURLToPath(new URL(specifier, context.parentURL))
    for (const candidate of [
      `${base}.js`,
      `${base}.jsx`,
      `${base}.ts`,
      join(base, "index.js"),
      join(base, "index.jsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, format: "module", shortCircuit: true }
      }
    }
    throw err
  }
}

export async function load(url, context, next) {
  if (url.startsWith(STUB_SCHEME)) {
    const spec = url.slice(STUB_SCHEME.length)
    return {
      format: "module",
      shortCircuit: true,
      source: stubs.get(spec) ?? stubSource(new Set()),
    }
  }

  /* Vite lets a component import its stylesheet; node does not, and the
     render tests only care about markup. Serve a blank module so the import
     resolves and the CSS stays out of the way. */
  if (url.startsWith("file:") && extname(url) === ".css") {
    return { format: "module", shortCircuit: true, source: "export default {}\n" }
  }

  const isLocal = url.startsWith("file:")

  /* Test double for a single project module (see buildModuleDoubles). The
     double's relative imports would resolve against the *real* file's
     directory, so doubles have to be self-contained — they import nothing. */
  if (isLocal && moduleDoubles.size) {
    const real = fileURLToPath(url)
    const double = moduleDoubles.get(real)
    if (double) {
      const raw = readFileSync(double, "utf8").split("import.meta.env").join("(globalThis.__VITE_ENV__ || {})")
      return {
        format: "module",
        shortCircuit: true,
        source:
          transform === "esbuild" && TRANSFORMABLE.has(extname(double))
            ? await esbuild(raw, double)
            : raw,
      }
    }
  }

  const needsTransform =
    transform === "esbuild" && isLocal && TRANSFORMABLE.has(extname(fileURLToPath(url)))

  let source
  let format = "module"

  if (needsTransform) {
    const file = fileURLToPath(url)
    source = await esbuild(readFileSync(file, "utf8"), file)
  } else {
    const result = await next(url, context)
    if (!result?.source) return result
    format = result.format || "module"
    source =
      typeof result.source === "string"
        ? result.source
        : Buffer.from(result.source).toString("utf8")
  }

  /* Vite's build-time constant. Replaced, not emptied, so config.js still
     sees the values it expects. */
  if (source.includes("import.meta.env")) {
    source = source.split("import.meta.env").join("(globalThis.__VITE_ENV__ || {})")
  }

  return { format, shortCircuit: true, source }
}
