#!/usr/bin/env node
/* ==========================================================================
   check-contrast — find text that is objectively hard to read
   --------------------------------------------------------------------------
   Static WCAG audit of the stylesheets. It is deliberately narrow: it only
   judges a rule when that SAME rule declares both a text colour and a
   background. That is the only case where the contrast ratio is knowable
   without a browser — a bare `color:` could land on any surface, and guessing
   produces noise people learn to ignore.

   Reports:
     FAIL  ratio < 3.0   — illegible for any text
     WARN  3.0–4.49      — below AA for body text (4.5), ok only for large
     ok    4.5+          — passes AA

   Alpha colours are composited over the rule's own background (or the sheet's
   assumed surface) before measuring, so rgba(16,24,20,.38) is not mistaken
   for solid black.
   ========================================================================== */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = process.cwd()
const SRC = join(ROOT, "src")

/* --------------------------------------------------------------- colour math */

function parseColor(raw) {
  const s = String(raw).trim()
  let m = s.match(/^#([0-9a-f]{3})$/i)
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16))
    return { r, g, b, a: 1 }
  }
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i)
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16)
    const g = parseInt(m[1].slice(2, 4), 16)
    const b = parseInt(m[1].slice(4, 6), 16)
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1
    return { r, g, b, a }
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    const [r, g, b] = parts
    const a = parts.length > 3 ? parts[3] : 1
    if ([r, g, b].some((n) => Number.isNaN(n))) return null
    return { r, g, b, a: Number.isNaN(a) ? 1 : a }
  }
  if (/^(white|black|red|blue|green|yellow|orange|purple|gray|grey|transparent)$/i.test(s)) {
    const named = {
      white: { r: 255, g: 255, b: 255 },
      black: { r: 0, g: 0, b: 0 },
      transparent: { r: 0, g: 0, b: 0, a: 0 },
    }
    const n = named[s.toLowerCase()]
    return n ? { a: 1, ...n } : null
  }
  return null
}

const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})

const srgb = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const lum = ({ r, g, b }) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)

function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/* --------------------------------------------------------------- css walking */

function cssFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) cssFiles(p, out)
    else if (name.endsWith(".css")) out.push(p)
  }
  return out
}

/* Split a stylesheet into top-level rules. Good enough for a lint: we do not
   need a full cascade, only "does this declaration block set both colour and
   background". @media/@supports wrappers are flattened — their inner rules are
   collected on their own, which is what we want. */
function blocks(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const sel = m[1].trim().replace(/\/\*[\s\S]*?\*\//g, "").trim()
    if (!sel || sel.startsWith("@")) continue
    out.push({ sel, body: m[2] })
  }
  return out
}

const decl = (body, prop) => {
  const re = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+)`, "i")
  const m = body.match(re)
  return m ? m[1].trim() : null
}

/* A translucent background is not a surface — it is a TINT over one. Measuring
   rgba(226,61,40,.12) as if it were opaque reports 1.0:1 and screams about
   perfectly legible error text, which is how an audit gets ignored. So each
   sheet declares the surface its tints are painted on; anything unlisted is
   assumed to sit on the dark gateway panel. */
const BASE_SURFACE = {
  "src/styles/admin-ragestar.css": "#f0f2e8",
  "src/styles/admin-v12.css": "#ffffff",
  "src/styles/dashboard-snow.css": "#ffffff",
  "src/styles/dashboard-v12.css": "#ffffff",
  "src/styles/flim.css": "#f4f4f2",
  "src/styles/minimal.css": "#191919",
  "src/ragestar/chrome.css": "#e9ece4",
  "src/ragestar/theme.css": "#e9ece4",
}
const DEFAULT_BASE = "#0b111f"

const files = cssFiles(SRC)
const findings = []

for (const file of files) {
  const css = readFileSync(file, "utf8")
  const lines = css.split("\n")
  const rel = relative(ROOT, file).replace(/\\/g, "/")
  const base = parseColor(BASE_SURFACE[rel] || DEFAULT_BASE)

  for (const { sel, body } of blocks(css)) {
    const colorRaw = decl(body, "color")
    const bgRaw =
      decl(body, "background-color") ||
      decl(body, "background") ||
      decl(body, "background-image")
    if (!colorRaw || !bgRaw) continue
    /* gradients / images: we cannot measure their average, skip */
    if (/gradient|url\(|var\(/i.test(bgRaw)) continue
    if (/var\(/i.test(colorRaw)) continue

    const fg = parseColor(colorRaw)
    const bgRawParsed = parseColor(bgRaw)
    if (!fg || !bgRawParsed) continue

    /* flatten the tint onto the surface, then flatten the text onto that */
    const bg = bgRawParsed.a < 1 ? over(bgRawParsed, base) : bgRawParsed
    const composited = over(fg, bg)
    const r = ratio(composited, bg)
    if (r >= 4.5) continue

    const idx = css.indexOf(body)
    const line = idx >= 0 ? css.slice(0, idx).split("\n").length : 0
    findings.push({
      file: rel,
      line,
      sel: sel.replace(/\s+/g, " ").slice(0, 70),
      color: colorRaw,
      bg: bgRaw,
      ratio: r,
      text: (lines[line - 1] || "").trim().slice(0, 80),
    })
  }
}

/* ------------------------------------------------------------------- report */

const paint = process.stdout.isTTY
  ? {
      dim: (s) => `\u001b[2m${s}\u001b[0m`,
      bold: (s) => `\u001b[1m${s}\u001b[0m`,
      red: (s) => `\u001b[31m${s}\u001b[0m`,
      amber: (s) => `\u001b[33m${s}\u001b[0m`,
      green: (s) => `\u001b[32m${s}\u001b[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, red: (s) => s, amber: (s) => s, green: (s) => s }

console.log(paint.bold(`check-contrast  ${ROOT}`))
console.log()

const fails = findings.filter((f) => f.ratio < 3)
const warns = findings.filter((f) => f.ratio >= 3 && f.ratio < 4.5)

const show = (list, label, colour) => {
  for (const f of list) {
    console.log(
      `${colour(label)} ${f.file}:${f.line}  ${paint.dim(f.sel)}\n` +
        `        ${f.ratio.toFixed(2)}:1   color: ${f.color}  on  ${f.bg}`,
    )
  }
}

show(fails, "FAIL", paint.red)
show(warns, "WARN", paint.amber)
console.log()

if (!findings.length) {
  console.log(paint.green("  ok   no low-contrast text/background pairs found"))
} else {
  console.log(
    `${paint.bold(String(fails.length))} illegible (<3:1), ` +
      `${warns.length} below AA (3–4.5:1), across ${files.length} stylesheets`,
  )
}
console.log()
process.exit(fails.length ? 1 : 0)
