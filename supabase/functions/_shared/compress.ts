/* ==========================================================================
   Router-side token compression
   --------------------------------------------------------------------------
   A Deno port of src/lib/compress.js, kept deliberately small: the same stage
   ids, the same order semantics, no model calls. The admin panel previews with
   the browser copy; the router applies this one. If the two ever disagree on a
   stage id, the unknown id is skipped rather than guessed at.
   ========================================================================== */

export type Compressor = {
  name?: string
  slug?: string
  stages?: string[]
  scope?: "all" | "user" | "system" | "history"
  min_tokens?: number
  max_chars?: number
  preserve_code?: boolean
  priority?: number
  is_active?: boolean
  model_ids?: string[]
  /* v11 — conversation-level modes. Absent means "stages", which is v9. */
  mode?: "stages" | "ponytail"
  head_messages?: number
  keep_system?: boolean
  tail_chars?: number
  tail_digest?: boolean
  keep_entities?: boolean
}

type Msg = { role?: string; content?: unknown }

export function estimateTokens(text: string): number {
  const s = String(text || "")
  if (!s) return 0
  const chars = s.length / 4
  const words = (s.match(/[A-Za-z0-9'’]+|[^\sA-Za-z0-9]/g) || []).length * 1.3
  return Math.max(1, Math.round((chars + words) / 2))
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text || ""))
      .join("\n")
  }
  return ""
}

const FILLER = [
  "please note that", "please be aware that", "it is important to note that",
  "as you may know", "as you know", "needless to say", "in order to",
  "due to the fact that", "at this point in time", "for all intents and purposes",
  "it should be noted that", "i would like you to", "i want you to",
  "could you please", "can you please", "kindly", "basically", "actually",
  "essentially", "really", "very", "just", "simply", "literally",
  "in my opinion", "to be honest", "sort of", "kind of",
]

const SHORTHAND: Array<[RegExp, string]> = [
  [/\bfor example\b/gi, "e.g."],
  [/\bthat is to say\b/gi, "i.e."],
  [/\bapproximately\b/gi, "~"],
  [/\bbecause\b/gi, "b/c"],
  [/\bwithout\b/gi, "w/o"],
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
  [/\bparameters?\b/gi, "params"],
  [/\bmaximum\b/gi, "max"],
  [/\bminimum\b/gi, "min"],
]

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "is", "are",
  "was", "were", "be", "been", "being", "that", "this", "these", "those",
  "it", "its", "as", "from", "there", "here", "then", "than", "so", "such",
])

const STAGES: Record<string, (t: string, c: Compressor) => string> = {
  whitespace: (t) =>
    t.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+$/gm, "").trim(),
  markdown: (t) =>
    t.replace(/^\s{0,3}#{1,6}\s*/gm, "").replace(/\*\*|__|~~/g, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "").replace(/^\s*[-*+]\s+/gm, "- ")
      .replace(/\|\s+/g, "|"),
  html: (t) => t.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-z][^>]*>/gi, ""),
  json: (t) =>
    t.replace(/\{[\s\S]{40,}?\}/g, (block) => {
      try {
        return JSON.stringify(JSON.parse(block))
      } catch {
        return block
      }
    }),
  dedupe: (t) => {
    const seen = new Set<string>()
    return t.split("\n").filter((line) => {
      const k = line.trim().toLowerCase()
      if (!k) return true
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).join("\n")
  },
  filler: (t) => {
    let out = t
    for (const phrase of FILLER) out = out.replace(new RegExp(`\\b${phrase}\\b[,]?\\s*`, "gi"), "")
    return out.replace(/ {2,}/g, " ")
  },
  shorthand: (t) => {
    let out = t
    for (const [re, to] of SHORTHAND) out = out.replace(re, to)
    return out
  },
  stopwords: (t) =>
    t.split("\n").map((line) =>
      line.split(/(\s+)/)
        .filter((w) => !w.trim() || !STOPWORDS.has(w.trim().toLowerCase().replace(/[^a-z']/g, "")))
        .join("").replace(/ {2,}/g, " ").trim(),
    ).join("\n"),
  vowels: (t) =>
    t.replace(/\b[A-Za-z]{8,}\b/g, (w) => w[0] + w.slice(1, -1).replace(/[aeiou]/g, "") + w[w.length - 1]),
  middleout: (t, c) => {
    const budget = Math.max(120, Number(c?.max_chars) || 4000)
    if (t.length <= budget) return t
    const keep = Math.floor(budget / 2) - 20
    return `${t.slice(0, keep)}\n…[${t.length - keep * 2} chars trimmed]…\n${t.slice(-keep)}`
  },
}

const FENCE = /```[\s\S]*?```|`[^`\n]+`/g

function compressOne(text: string, c: Compressor): string {
  const stages = (c.stages || []).filter((id) => STAGES[id])
  if (!stages.length) return text
  if (estimateTokens(text) < (Number(c.min_tokens) || 0)) return text

  const vault: string[] = []
  let current = c.preserve_code === false
    ? text
    : text.replace(FENCE, (hit) => {
        vault.push(hit)
        return `\u0000${vault.length - 1}\u0000`
      })

  for (const id of stages) {
    try {
      current = STAGES[id](current, c) || ""
    } catch {
      /* a bad stage must never cost the caller their request */
    }
  }

  if (vault.length) {
    current = current.replace(/\u0000(\d+)\u0000/g, (_, i: string) => vault[Number(i)] ?? "")
  }
  return current.trim()
}

function inScope(list: Msg[], i: number, scope: string): boolean {
  const role = list[i]?.role
  if (scope === "user") return role === "user"
  if (scope === "system") return role === "system"
  if (scope === "history") return i < list.length - 1
  return true
}

export type CompressionResult = {
  messages: Msg[]
  before: number
  after: number
  saved: number
  applied: string[]
}

/** Run every enabled compressor over a chat payload, priority order first. */
export function applyCompressors(messages: unknown, compressors: Compressor[]): CompressionResult {
  const list: Msg[] = Array.isArray(messages) ? (messages as Msg[]) : []
  const count = (l: Msg[]) => l.reduce((s, m) => s + estimateTokens(textOf(m?.content)) + 4, 0)
  const before = count(list)

  const active = (compressors || [])
    .filter((c) => c && c.is_active !== false && ((c.stages || []).length || c.mode === "ponytail"))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))

  let current = list
  const applied: string[] = []

  for (const c of active) {
    if (c.mode === "ponytail") {
      const tied = ponytail(current, c)
      if (tied !== current) {
        current = tied
        applied.push(c.slug || c.name || "ponytail")
      }
      continue
    }
    let touched = false
    const next = current.map((m, i) => {
      if (!inScope(current, i, c.scope || "all")) return m
      const body = textOf(m?.content)
      if (!body) return m
      const out = compressOne(body, c)
      if (out === body) return m
      touched = true
      return { ...m, content: out }
    })
    current = next
    if (touched) applied.push(c.slug || c.name || "compressor")
  }

  const after = count(current)
  return { messages: current, before, after, saved: Math.max(0, before - after), applied }
}

/* ================================================================ ponytail */
/* The router-side twin of compressPonytail() in src/lib/compress.js. The
   admin panel previews with that copy; this one is what actually reaches the
   upstream, so the two have to agree on the shape of the result. */

const ENTITY =
  /https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|\b[A-Za-z0-9_-]{20,}\b|\$\d[\d,.]*|\b\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b[A-Z][A-Z0-9_]{2,}\b/g

function spine(text: string, budget: number, keepEntities: boolean): string {
  const source = String(text || "").trim()
  if (source.length <= budget) return source

  const vault: string[] = []
  let out = keepEntities
    ? source.replace(ENTITY, (hit) => {
        vault.push(hit)
        return `\u0001${vault.length - 1}\u0001`
      })
    : source

  out = out
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\s+/g, " ")

  for (const phrase of FILLER) out = out.replace(new RegExp(`\\b${phrase}\\b[,]?\\s*`, "gi"), "")

  if (vault.length) {
    out = out.replace(/\u0001(\d+)\u0001/g, (_, i: string) => vault[Number(i)] ?? "")
  }
  out = out.replace(/ {2,}/g, " ").trim()
  if (out.length <= budget) return out

  const keep = Math.max(60, Math.floor(budget / 2) - 12)
  return `${out.slice(0, keep).trim()} … ${out.slice(-keep).trim()}`
}

function ponytail(list: Msg[], c: Compressor): Msg[] {
  const count = (l: Msg[]) => l.reduce((s, m) => s + estimateTokens(textOf(m?.content)) + 4, 0)
  if (count(list) < (Number(c.min_tokens) || 0)) return list

  const head = Math.max(0, Math.round(Number(c.head_messages ?? 4)))
  const keepSystem = c.keep_system !== false
  const tailChars = Math.max(120, Math.round(Number(c.tail_chars ?? 700)))
  const digestOn = c.tail_digest !== false
  const keepEntities = c.keep_entities !== false
  const boundary = list.length - head

  const squeezed = new Map<number, string>()
  list.forEach((m, i) => {
    if (i >= boundary) return
    if (keepSystem && m?.role === "system") return
    const body = textOf(m?.content)
    if (!body) return
    const stages = (c.stages || []).length
      ? c.stages
      : ["whitespace", "markdown", "filler", "dedupe"]
    const first = compressOne(body, { ...c, mode: "stages", min_tokens: 0, max_chars: tailChars, stages })
    const out = spine(first, tailChars, keepEntities)
    if (out && out !== body) squeezed.set(i, out)
  })

  if (!squeezed.size) return list

  if (!digestOn) {
    return list.map((m, i) => (squeezed.has(i) ? { ...m, content: squeezed.get(i) } : m))
  }

  const indexes = [...squeezed.keys()].sort((a, b) => a - b)
  const body = indexes.map((i) => `${list[i]?.role || "user"}: ${squeezed.get(i)}`).join("\n")
  const digest: Msg = {
    ...list[indexes[0]],
    content: `[earlier conversation, compressed — ${indexes.length} turns]\n${body}`,
  }

  const out: Msg[] = []
  list.forEach((m, i) => {
    if (!squeezed.has(i)) {
      out.push(m)
      return
    }
    if (i === indexes[0]) out.push(digest)
  })
  return out
}
