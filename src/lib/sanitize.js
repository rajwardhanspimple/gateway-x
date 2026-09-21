/* ==========================================================================
   RageStar — client-side sanitisation helpers
   --------------------------------------------------------------------------
   Everything that could end up inside the DOM, a URL, or a JSON.parse() call
   goes through this file. The rule in this codebase is simple:

     * never pass a string to dangerouslySetInnerHTML directly
     * never trust a string that came from the database, an upstream API,
       a query string, or a form field

   These helpers are intentionally small and dependency-free so they can be
   audited in one sitting.
   ========================================================================== */

/** Escape the five characters that let a string break out of HTML/attributes. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Strip control characters that can be used to smuggle payloads past logs. */
export function stripControlChars(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

/** Plain text for display: control chars gone, length capped. */
export function safeText(value, max = 2000) {
  return stripControlChars(value).slice(0, max)
}

/* -------------------------------------------------------------------- SVG */

/* Only these tags and attributes survive sanitizeSvg(). No <script>, no
   <foreignObject>, no <use href>, no event handlers, no url() references. */
const SVG_TAGS = new Set([
  "svg",
  "g",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "title",
])

const SVG_ATTRS = new Set([
  "viewbox",
  "xmlns",
  "class",
  "id",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "points",
  "opacity",
  "transform",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "pathlength",
  "aria-hidden",
  "focusable",
  "role",
])

const UNSAFE_VALUE = /javascript:|data:text\/html|vbscript:|expression\(|url\(/i

/**
 * Allow-list sanitiser for the inline icon markup in `brand.jsx`.
 *
 * The icon strings shipped with the app are static, but this function is the
 * only door into `dangerouslySetInnerHTML` anywhere in the project, so even a
 * future icon coming from the database (or an attacker-controlled settings
 * row) cannot introduce script execution.
 */
export function sanitizeSvg(markup) {
  const input = String(markup ?? "")
  if (!input) return ""

  // Kill comments, CDATA and anything that even looks like a script/handler.
  let out = input
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")

  if (/<\s*(script|foreignobject|iframe|object|embed|style|animate|set|use)\b/i.test(out)) {
    return ""
  }

  // Rebuild every tag from allow-listed parts only.
  out = out.replace(/<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*)?)\/?\s*>/g, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase()
    if (!SVG_TAGS.has(tag)) return ""
    if (match.startsWith("</")) return `</${tag}>`

    const selfClosing = /\/\s*>$/.test(match)
    const attrs = []
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'<>`]+)/g
    let m
    while ((m = attrRe.exec(rawAttrs || "")) !== null) {
      const name = m[1].toLowerCase()
      const value = m[2].replace(/^["']|["']$/g, "")
      if (name.startsWith("on")) continue
      if (!SVG_ATTRS.has(name)) continue
      if (UNSAFE_VALUE.test(value)) continue
      attrs.push(`${name}="${escapeHtml(value)}"`)
    }
    return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing ? "/" : ""}>`
  })

  return out
}

/* -------------------------------------------------------------------- URLs */

/** True only for http(s) URLs — blocks javascript:, data:, blob:, file:. */
export function isSafeHttpUrl(value) {
  try {
    const u = new URL(String(value ?? "").trim())
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}

/** A link target you can safely put in href. Anything odd becomes "#". */
export function safeHref(value) {
  const raw = String(value ?? "").trim()
  if (raw.startsWith("#/") || raw.startsWith("#")) return raw.replace(/["'<>]/g, "")
  return isSafeHttpUrl(raw) ? raw : "#"
}

/**
 * Upstream base URLs must be public HTTPS endpoints. Blocking loopback and
 * private ranges here stops an admin-panel field from being turned into an
 * SSRF probe against the Supabase network.
 */
export function validateUpstreamBaseUrl(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return "A base URL is required"
  let u
  try {
    u = new URL(raw)
  } catch {
    return "Enter a full URL, for example https://api.example.com/v1"
  }
  if (u.protocol !== "https:") return "Use https:// for upstream endpoints"
  if (u.username || u.password) return "Do not put credentials in the URL"
  const host = u.hostname.toLowerCase()
  const blocked =
    host === "localhost" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host === "metadata.google.internal"
  if (blocked) return "That host is not reachable from the gateway (private or loopback address)"
  return ""
}

/* -------------------------------------------------------------------- JSON */

/**
 * JSON.parse that cannot throw and cannot return a prototype-polluting
 * object. Used for every admin-entered JSON blob (extra headers, etc).
 */
export function safeJsonParse(text, fallback = {}) {
  const raw = String(text ?? "").trim()
  if (!raw) return fallback
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  return stripProtoKeys(parsed)
}

function stripProtoKeys(value) {
  if (Array.isArray(value)) return value.map(stripProtoKeys)
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue
      out[k] = stripProtoKeys(v)
    }
    return out
  }
  return value
}

/**
 * Header maps typed by an admin: keys must look like HTTP header names and
 * values must be single-line. Blocks CRLF header injection.
 */
export function sanitizeHeaderMap(input) {
  const source = typeof input === "string" ? safeJsonParse(input, {}) : stripProtoKeys(input || {})
  const out = {}
  for (const [k, v] of Object.entries(source)) {
    const name = String(k).trim()
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (/^(authorization|cookie|host|content-length)$/i.test(name)) continue
    const value = String(v ?? "").replace(/[\r\n]/g, "").slice(0, 1024)
    out[name] = value
  }
  return out
}