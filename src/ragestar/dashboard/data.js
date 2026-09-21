/* ==========================================================================
   data.js — reference data only
   --------------------------------------------------------------------------
   This file used to also hold a deterministic pseudo-random generator and the
   demo datasets built from it: request tails, per-model usage shares, invoices,
   an activity feed, budget alerts, a starter set of API keys and a chart
   series. Every one of them rendered immediately and was then replaced by the
   account's real numbers, which produced the "shows one thing, then changes"
   flicker — and on the status page, invented uptime history presented as fact.

   Nothing here fabricates anything now. What is left is the live model
   catalog, the window selector, the scope list and two formatters. The publish
   path may still legitimately use `models` as its static catalog; everything
   dynamic reads the workspace.
   ========================================================================== */

/** The window selector on the Usage and Overview screens. */
export const ranges = [
  { id: "24h", label: "24h", points: 24 },
  { id: "7d", label: "7D", points: 14 },
  { id: "30d", label: "30D", points: 30 },
  { id: "90d", label: "90D", points: 30 },
];

/* ------------------------------------------------------------------ models */

export const models = [
  {
    id: "ragestar-4-turbo",
    name: "RageStar 4 Turbo",
    provider: "RageStar",
    blurb: "Flagship generalist. Best quality-per-millisecond for agents, tools and long context.",
    context: 256000,
    priceIn: 2.5,
    priceOut: 10,
    modality: ["text", "vision", "code"],
    ttft: 172,
    throughput: 118,
    license: "Proprietary",
    status: "ga",
    tags: ["flagship", "tool calling", "JSON mode"],
    strengths: ["Complex reasoning", "Structured outputs", "Long documents"],
  },
  {
    id: "ragestar-4-mini",
    name: "RageStar 4 Mini",
    provider: "RageStar",
    blurb: "Fast, cheap everyday driver for classification, extraction and chat at scale.",
    context: 128000,
    priceIn: 0.18,
    priceOut: 0.72,
    modality: ["text", "code"],
    ttft: 96,
    throughput: 244,
    license: "Proprietary",
    status: "ga",
    tags: ["cheapest", "high throughput"],
    strengths: ["Routing & triage", "Batch enrichment", "High volume chat"],
  },
  {
    id: "ragestar-reason-1",
    name: "RageStar Reason 1",
    provider: "RageStar",
    blurb: "Deliberate reasoning model with visible thinking traces and verification steps.",
    context: 200000,
    priceIn: 3.2,
    priceOut: 14,
    modality: ["text", "code"],
    ttft: 640,
    throughput: 46,
    license: "Proprietary",
    status: "ga",
    tags: ["reasoning", "math", "agents"],
    strengths: ["Math & proofs", "Multi-step planning", "Code review"],
  },
  {
    id: "astra-gpt6",
    name: "Astra GPT-6",
    provider: "Astra",
    blurb: "Frontier generalist for agentic work: long-horizon planning, tool use and vision.",
    context: 400000,
    priceIn: 2.5,
    priceOut: 10,
    modality: ["text", "vision", "code"],
    ttft: 190,
    throughput: 104,
    license: "Proprietary",
    status: "ga",
    tags: ["flagship", "tool calling", "vision"],
    strengths: ["Agentic workflows", "Long documents", "Multimodal QA"],
  },
  {
    id: "ragestar-vision-1",
    name: "RageStar Vision 1",
    provider: "RageStar",
    blurb: "Document, chart and screenshot understanding with spatial grounding.",
    context: 128000,
    priceIn: 1.4,
    priceOut: 4.2,
    modality: ["vision", "text"],
    ttft: 260,
    throughput: 82,
    license: "Proprietary",
    status: "ga",
    tags: ["vision", "OCR"],
    strengths: ["Invoices & forms", "Chart QA", "UI understanding"],
  },
  {
    id: "ragestar-rerank-v2",
    name: "RageStar Rerank v2",
    provider: "RageStar",
    blurb: "Cross-encoder reranker that lifts RAG precision by up to 34%.",
    context: 16000,
    priceIn: 0.03,
    priceOut: 0,
    modality: ["rerank"],
    ttft: 42,
    throughput: 0,
    license: "RageStar distilled",
    status: "ga",
    tags: ["RAG", "retrieval"],
    strengths: ["Precision@k", "Hybrid search", "Cost control"],
  },
  {
    id: "ragestar-2-research",
    name: "RageStar 2 Research",
    provider: "RageStar",
    blurb: "Next-gen sparse model with 1M-token context. Limited preview capacity.",
    context: 1000000,
    priceIn: 1.9,
    priceOut: 7.6,
    modality: ["text", "vision"],
    ttft: 480,
    throughput: 64,
    license: "Proprietary",
    status: "preview",
    tags: ["1M context", "preview"],
    strengths: ["Whole-repo analysis", "Book-length input", "Research agents"],
  },
];

/* ------------------------------------------------------- model formatting */

/** Context window as the short label the tables use: 128000 → "128k",
 *  1000000 → "1M". The old `(tokens / 1000).toFixed(0) + "k"` turned the
 *  1M-token model into "1000k". */
export function contextLabel(tokens) {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

/** A per-unit price, keeping sub-cent rates intact. A flat two-decimal format
 *  is what printed a $0.003-per-image rate as "$0.00" — i.e. free. */
export function priceLabel(value) {
  if (value == null) return "—";
  if (value === 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

export const modelFilters = [
  { id: "all", label: "All models" },
  { id: "text", label: "Text" },
  { id: "code", label: "Code" },
  { id: "vision", label: "Vision" },
  { id: "embedding", label: "Embeddings" },
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
  { id: "open", label: "Open weights" },
];

export const allScopes = ["chat", "embeddings", "images", "audio", "rerank", "fine-tune", "admin"];
