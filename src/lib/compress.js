/* ==========================================================================
   Token compressor
   --------------------------------------------------------------------------
   A prompt goes in, a smaller prompt comes out. Nothing here calls a model:
   every stage is a deterministic text transform, so the same input always
   produces the same output and the saving can be measured before a request
   is ever forwarded.

   Several compressors can exist at once. Each one is a named stack of stages
   plus a scope (which messages it touches) and a floor (how big a prompt has
   to be before it is worth rewriting). The admin panel stores a list of them
   and the router runs the enabled ones in priority order.
   ========================================================================== */

/* ------------------------------------------------------------- estimation */

/** Rough token count. Blends the 4-chars-per-token rule with a word count so
 *  that code and prose both land within ~10% of a real BPE tokenizer. */
export function estimateTokens(text) {
  const s = String(text || "")
  if (!s) return 0
  const chars = s.length / 4
  const words = (s.match(/[A-Za-z0-9'’]+|[^\sA-Za-z0-9]/g) || []).length * 1.3
  return Math.max(1, Math.round((chars + words) / 2))
}

export function messagesTokens(messages) {
  return (messages || []).reduce(
    (sum, m) => sum + estimateTokens(textOf(m?.content)) + 4,
    0,
  )
}

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join("\n")
  }
  return ""
}

/* ------------------------------------------------------------ code fences */

const FENCE = /```[\s\S]*?```|`[^`\n]+`/g

function protect(text, on) {
  if (!on) return { text, vault: [] }
  const vault = []
  const masked = text.replace(FENCE, (hit) => {
    vault.push(hit)
    return `\u0000${vault.length - 1}\u0000`
  })
  return { text: masked, vault }
}

function restore(text, vault) {
  if (!vault.length) return text
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => vault[Number(i)] ?? "")
}

/* ----------------------------------------------------------------- stages */

const FILLER = [
  "please note that", "please be aware that", "it is important to note that",
  "as you may know", "as you know", "needless to say", "in order to",
  "due to the fact that", "at this point in time", "for all intents and purposes",
  "it should be noted that", "i would like you to", "i want you to",
  "could you please", "can you please", "kindly", "basically", "actually",
  "essentially", "really", "very", "just", "simply", "literally",
  "in my opinion", "to be honest", "sort of", "kind of",
]

const SHORTHAND = [
  [/\bfor example\b/gi, "e.g."],
  [/\bthat is to say\b/gi, "i.e."],
  [/\bapproximately\b/gi, "~"],
  [/\bbecause\b/gi, "b/c"],
  [/\bwith(?:out)?\b/gi, (m) => (m.toLowerCase() === "without" ? "w/o" : "w/")],
  [/\bnumber of\b/gi, "#"],
  [/\band\b/gi, "&"],
  [/\bgreater than\b/gi, ">"],
  [/\bless than\b/gi, "<"],
  [/\bversus\b/gi, "vs"],
  [/\bapplication\b/gi, "app"],
  [/\bconfiguration\b/gi, "config"],
  [/\bdocumentation\b/gi, "docs"],
  [/\binformation\b/gi, "info"],
  [/\brequirements?\b/gi, "reqs"],
  [/\bfunction\b/gi, "fn"],
  [/\bparameters?\b/gi, "params"],
  [/\bmaximum\b/gi, "max"],
  [/\bminimum\b/gi, "min"],
]

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "is", "are",
  "was", "were", "be", "been", "being", "that", "this", "these", "those",
  "it", "its", "as", "from", "there", "here", "then", "than", "so", "such",
])

/** Every stage: id, label, what it does, and whether it can change meaning. */
export const STAGES = [
  {
    id: "whitespace",
    label: "Collapse whitespace",
    lossy: false,
    note: "Runs of spaces, tabs and blank lines become one.",
    run: (t) =>
      t
        .replace(/[ \t]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+$/gm, "")
        .trim(),
  },
  {
    id: "markdown",
    label: "Strip markdown noise",
    lossy: false,
    note: "Drops decoration: **, __, ###, ---, table pipes, bullet padding.",
    run: (t) =>
      t
        .replace(/^\s{0,3}#{1,6}\s*/gm, "")
        .replace(/\*\*|__|~~/g, "")
        .replace(/^\s*[-*_]{3,}\s*$/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "- ")
        .replace(/\|\s+/g, "|"),
  },
  {
    id: "html",
    label: "Strip HTML tags",
    lossy: false,
    note: "Removes tags and comments, keeps the text between them.",
    run: (t) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-z][^>]*>/gi, ""),
  },
  {
    id: "json",
    label: "Minify JSON blocks",
    lossy: false,
    note: "Pretty-printed JSON found in the text is re-serialised compactly.",
    run: (t) =>
      t.replace(/\{[\s\S]{40,}?\}/g, (block) => {
        try {
          return JSON.stringify(JSON.parse(block))
        } catch {
          return block
        }
      }),
  },
  {
    id: "dedupe",
    label: "Drop repeated lines",
    lossy: false,
    note: "Identical non-empty lines are kept once.",
    run: (t) => {
      const seen = new Set()
      return t
        .split("\n")
        .filter((line) => {
          const k = line.trim().toLowerCase()
          if (!k) return true
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        .join("\n")
    },
  },
  {
    id: "filler",
    label: "Cut filler phrases",
    lossy: true,
    note: "Removes politeness and padding that carries no instruction.",
    run: (t) => {
      let out = t
      for (const phrase of FILLER) {
        out = out.replace(new RegExp(`\\b${phrase}\\b[,]?\\s*`, "gi"), "")
      }
      return out.replace(/ {2,}/g, " ")
    },
  },
  {
    id: "shorthand",
    label: "Abbreviate common words",
    lossy: true,
    note: "config, docs, params, e.g., ~, & — a fixed dictionary, no guessing.",
    run: (t) => {
      let out = t
      for (const [re, to] of SHORTHAND) out = out.replace(re, to)
      return out
    },
  },
  {
    id: "stopwords",
    label: "Remove stopwords",
    lossy: true,
    note: "Aggressive. Articles and copulas go; reads like a telegram.",
    run: (t) =>
      t
        .split("\n")
        .map((line) =>
          line
            .split(/(\s+)/)
            .filter((w) => !STOPWORDS.has(w.trim().toLowerCase().replace(/[^a-z']/g, "")) || !w.trim())
            .join("")
            .replace(/ {2,}/g, " ")
            .trim(),
        )
        .join("\n"),
  },
  {
    id: "vowels",
    label: "Drop vowels in long words",
    lossy: true,
    note: "Very aggressive. Words over 7 letters lose interior vowels.",
    run: (t) =>
      t.replace(/\b[A-Za-z]{8,}\b/g, (w) =>
        w[0] + w.slice(1, -1).replace(/[aeiou]/g, "") + w[w.length - 1],
      ),
  },
  {
    id: "middleout",
    label: "Middle-out truncation",
    lossy: true,
    note: "Keeps the head and tail of an oversized block, marks the gap.",
    run: (t, cfg) => {
      const budget = Math.max(120, Number(cfg?.max_chars) || 4000)
      if (t.length <= budget) return t
      const keep = Math.floor(budget / 2) - 20
      return `${t.slice(0, keep)}\n…[${t.length - keep * 2} chars trimmed]…\n${t.slice(-keep)}`
    },
  },
  {
    id: "ponytail",
    label: "Ponytail (tie the head, thin the tail)",
    lossy: true,
    note: "Keeps the opening of a long block verbatim and thins everything after it.",
    run: (t, cfg) => {
      const head = Math.max(160, Math.round(Number(cfg?.head_chars) || 700))
      if (t.length <= head) return t
      const budget = Math.max(120, Math.round(Number(cfg?.tail_chars) || 900))
      const tail = t.slice(head)
      const spine = keywordSpine(tail, budget, cfg?.keep_entities !== false)
      return `${t.slice(0, head)}
…[tail thinned ${tail.length}→${spine.length} chars]…
${spine}`
    },
  },
]

export const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]))

/* ---------------------------------------------------------------- presets */

export const SCOPES = [
  { id: "all", label: "Every message" },
  { id: "user", label: "User messages only" },
  { id: "system", label: "System prompt only" },
  { id: "history", label: "Everything except the last message" },
]

/** How a compressor reads a payload. `stages` rewrites each message on its
 *  own, which is everything v9 could do. `ponytail` reads the conversation as
 *  one shape: the system prompt and the newest turns stay verbatim, the older
 *  turns are squeezed and optionally tied into a single digest turn. */
export const MODES = [
  {
    id: "stages",
    label: "Stages (per message)",
    note: "Every message in scope is rewritten by the stage stack.",
  },
  {
    id: "ponytail",
    label: "Ponytail (whole conversation)",
    note: "Newest turns and the system prompt are untouched; older turns are thinned into one digest.",
  },
]

/** The compressors a fresh install starts with. Multiple by design: a safe
 *  one for everything, a tighter one for long context, a JSON one for tools. */
export const PRESETS = [
  {
    slug: "tidy",
    name: "Tidy (lossless)",
    description: "Whitespace, markdown decoration and duplicate lines. Safe for every prompt.",
    stages: ["whitespace", "markdown", "dedupe"],
    scope: "all",
    min_tokens: 0,
    max_chars: 8000,
    preserve_code: true,
    priority: 10,
    is_active: true,
  },
  {
    slug: "prompt-diet",
    name: "Prompt diet",
    description: "Adds filler removal and the abbreviation dictionary. Good default for chat.",
    stages: ["whitespace", "markdown", "filler", "shorthand", "dedupe"],
    scope: "user",
    min_tokens: 120,
    max_chars: 8000,
    preserve_code: true,
    priority: 20,
    is_active: true,
  },
  {
    slug: "history-squeeze",
    name: "History squeeze",
    description: "Only rewrites older turns, and truncates them middle-out past the budget.",
    stages: ["whitespace", "filler", "stopwords", "middleout"],
    scope: "history",
    min_tokens: 400,
    max_chars: 3000,
    preserve_code: true,
    priority: 30,
    is_active: false,
  },
  {
    slug: "json-slim",
    name: "JSON slim",
    description: "For tool output and pasted payloads: minifies JSON, strips HTML.",
    stages: ["json", "html", "whitespace"],
    scope: "all",
    min_tokens: 200,
    max_chars: 12000,
    preserve_code: false,
    priority: 40,
    is_active: false,
  },
  {
    slug: "ponytail",
    name: "Ponytail",
    description:
      "Keeps the system prompt and the last few turns word for word, ties everything older into one compressed digest. Long chats stop growing.",
    mode: "ponytail",
    stages: ["whitespace", "markdown", "filler", "dedupe"],
    scope: "history",
    min_tokens: 600,
    max_chars: 8000,
    preserve_code: true,
    head_messages: 4,
    keep_system: true,
    tail_chars: 700,
    tail_digest: true,
    keep_entities: true,
    priority: 50,
    is_active: false,
  },
]

export const EMPTY_COMPRESSOR = {
  name: "",
  slug: "",
  description: "",
  mode: "stages",
  stages: ["whitespace"],
  scope: "all",
  min_tokens: 0,
  max_chars: 6000,
  preserve_code: true,
  head_messages: 4,
  keep_system: true,
  tail_chars: 700,
  tail_digest: true,
  keep_entities: true,
  priority: 100,
  is_active: true,
}

/* ------------------------------------------------------------------ engine */

/** Run one compressor over a single string. Returns the text plus a per-stage
 *  trace, which is what the admin preview renders. */
export function compressText(text, compressor) {
  const source = String(text || "")
  const before = estimateTokens(source)
  const stages = (compressor?.stages || []).filter((id) => STAGE_MAP[id])

  if (!stages.length) {
    return { text: source, before, after: before, saved: 0, ratio: 0, trace: [], skipped: "no stages" }
  }
  if (Number(compressor?.min_tokens) > before) {
    return {
      text: source, before, after: before, saved: 0, ratio: 0, trace: [],
      skipped: `under the ${compressor.min_tokens} token floor`,
    }
  }

  const held = protect(source, compressor?.preserve_code !== false)
  let current = held.text
  const trace = []

  for (const id of stages) {
    const stage = STAGE_MAP[id]
    const was = estimateTokens(restore(current, held.vault))
    try {
      current = stage.run(current, compressor) || ""
    } catch {
      trace.push({ id, label: stage.label, saved: 0, failed: true })
      continue
    }
    const now = estimateTokens(restore(current, held.vault))
    trace.push({ id, label: stage.label, saved: Math.max(0, was - now), lossy: stage.lossy })
  }

  const out = restore(current, held.vault).trim()
  const after = estimateTokens(out)
  return {
    text: out,
    before,
    after,
    saved: Math.max(0, before - after),
    ratio: before ? Math.max(0, (before - after) / before) : 0,
    trace,
  }
}

function inScope(messages, index, scope) {
  const role = messages[index]?.role
  if (scope === "user") return role === "user"
  if (scope === "system") return role === "system"
  if (scope === "history") return index < messages.length - 1
  return true
}

/** Run one compressor across a chat payload. A ponytail compressor reads
 *  the whole conversation, so it is handed off whole; every other compressor
 *  still rewrites one message at a time. */
export function compressMessages(messages, compressor) {
  if ((compressor?.mode || "stages") === "ponytail") {
    return compressPonytail(messages, compressor)
  }
  const list = Array.isArray(messages) ? messages : []
  const before = messagesTokens(list)
  const out = list.map((m, i) => {
    if (!inScope(list, i, compressor?.scope || "all")) return m
    const body = textOf(m?.content)
    if (!body) return m
    const res = compressText(body, compressor)
    return res.text === body ? m : { ...m, content: res.text }
  })
  const after = messagesTokens(out)
  return {
    messages: out,
    before,
    after,
    saved: Math.max(0, before - after),
    ratio: before ? Math.max(0, (before - after) / before) : 0,
  }
}

/** Run every enabled compressor, in priority order, over one payload. */
export function compressPipeline(messages, compressors) {
  const active = (compressors || [])
    .filter(
      (c) =>
        c &&
        c.is_active !== false &&
        ((c.stages || []).length || c.mode === "ponytail"),
    )
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))

  let current = Array.isArray(messages) ? messages : []
  const before = messagesTokens(current)
  const steps = []

  for (const c of active) {
    const res = compressMessages(current, c)
    current = res.messages
    steps.push({ slug: c.slug, name: c.name, saved: res.saved, after: res.after })
  }

  const after = messagesTokens(current)
  return {
    messages: current,
    before,
    after,
    saved: Math.max(0, before - after),
    ratio: before ? Math.max(0, (before - after) / before) : 0,
    steps,
  }
}

/** Cost of a token count at a per-million price, for the savings readout. */
export function tokenCost(tokens, pricePerM) {
  const p = Number(pricePerM) || 0
  return (Number(tokens) || 0) * (p / 1_000_000)
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/* ================================================================ ponytail */
/* A ponytail ties the head and lets the rest hang thin. The system prompt and
   the newest turns are forwarded exactly as written — those are the turns a
   model actually answers from — while everything older is squeezed to a spine
   and, by default, folded into one digest turn. Deterministic: no model is
   consulted, so the same chat always compresses the same way.

   Identifiers, urls, money, dates and ALLCAPS tokens are held aside before the
   squeeze and put back afterwards, because those are exactly the fragments a
   later turn refers back to. */

const ENTITY =
  /https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|\b[A-Za-z0-9_-]{20,}\b|\$\d[\d,.]*|\b\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b[A-Z][A-Z0-9_]{2,}\b/g

function holdEntities(text) {
  const vault = []
  const masked = String(text).replace(ENTITY, (hit) => {
    vault.push(hit)
    return `\u0001${vault.length - 1}\u0001`
  })
  return { text: masked, vault }
}

function freeEntities(text, vault) {
  if (!vault.length) return text
  return text.replace(/\u0001(\d+)\u0001/g, (_, i) => vault[Number(i)] ?? "")
}

/** Thin a block of text down to `budget` characters without inventing words. */
export function keywordSpine(text, budget = 700, keepEntities = true) {
  const source = String(text || "").trim()
  if (source.length <= budget) return source

  const held = keepEntities ? holdEntities(source) : { text: source, vault: [] }
  let out = held.text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\s+/g, " ")
  for (const phrase of FILLER) {
    out = out.replace(new RegExp(`\\b${phrase}\\b[,]?\\s*`, "gi"), "")
  }
  out = freeEntities(out, held.vault).replace(/ {2,}/g, " ").trim()
  if (out.length <= budget) return out

  const keep = Math.max(60, Math.floor(budget / 2) - 12)
  return `${out.slice(0, keep).trim()} … ${out.slice(-keep).trim()}`
}

/** One older turn, squeezed: the compressor’s own stages run first, then the
 *  spine clips whatever is still over the tail budget. */
function squeezeTail(body, compressor, cfg) {
  const stages = (compressor?.stages || []).filter((id) => STAGE_MAP[id])
  const inner = {
    ...compressor,
    mode: "stages",
    min_tokens: 0,
    max_chars: cfg.tailChars,
    stages: stages.length ? stages : ["whitespace", "markdown", "filler", "dedupe"],
  }
  const first = compressText(body, inner).text || body
  return keywordSpine(first, cfg.tailChars, cfg.keepEntities)
}

/** Run a ponytail compressor across a whole chat payload. */
export function compressPonytail(messages, compressor) {
  const list = Array.isArray(messages) ? messages : []
  const before = messagesTokens(list)
  const untouched = { messages: list, before, after: before, saved: 0, ratio: 0 }

  if (Number(compressor?.min_tokens) > before) {
    return { ...untouched, skipped: `under the ${compressor.min_tokens} token floor` }
  }

  const cfg = {
    head: Math.max(0, Math.round(Number(compressor?.head_messages ?? 4))),
    keepSystem: compressor?.keep_system !== false,
    tailChars: Math.max(120, Math.round(Number(compressor?.tail_chars ?? 700))),
    digest: compressor?.tail_digest !== false,
    keepEntities: compressor?.keep_entities !== false,
  }

  const boundary = list.length - cfg.head
  const squeezed = new Map()

  list.forEach((m, i) => {
    if (i >= boundary) return
    if (cfg.keepSystem && m?.role === "system") return
    const body = textOf(m?.content)
    if (!body) return
    const out = squeezeTail(body, compressor, cfg)
    if (out && out !== body) squeezed.set(i, out)
  })

  if (!squeezed.size) return { ...untouched, skipped: "nothing old enough to tie back" }

  let out
  if (!cfg.digest) {
    out = list.map((m, i) => (squeezed.has(i) ? { ...m, content: squeezed.get(i) } : m))
  } else {
    const indexes = [...squeezed.keys()].sort((a, b) => a - b)
    const body = indexes
      .map((i) => `${list[i]?.role || "user"}: ${squeezed.get(i)}`)
      .join("\n")
    /* The digest keeps the role of the turn it replaces, so providers that
       insist on alternating roles (Anthropic) still see a valid transcript. */
    const digest = {
      ...list[indexes[0]],
      content: `[earlier conversation, compressed — ${indexes.length} turns]\n${body}`,
    }
    out = []
    list.forEach((m, i) => {
      if (!squeezed.has(i)) {
        out.push(m)
        return
      }
      if (i === indexes[0]) out.push(digest)
    })
  }

  const after = messagesTokens(out)
  return {
    messages: out,
    before,
    after,
    saved: Math.max(0, before - after),
    ratio: before ? Math.max(0, (before - after) / before) : 0,
    tied: squeezed.size,
  }
}
