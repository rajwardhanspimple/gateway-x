/* ==========================================================================
   docs.jsx — the RageStar documentation page, ported from the RageStar landing kit.
   Full API reference: quickstart, auth, chat, streaming, structured outputs,
   tools, embeddings, images, audio, errors, rate limits, regions, SDKs and
   the changelog, with the sticky filterable sidebar + reading rail.
   ========================================================================== */

import { useEffect, useState } from "react";
import { PageNav } from "./pages.jsx";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { CodeTabs, CopyButton } from "../dashboard/models.jsx";
import { Reveal, Badge } from "../components/ui.jsx";
import { cn } from "../lib/cn.js";
import { API_BASE, API_HOST } from "../lib/gateway.js";

const groups = [
  {
    name: "Get started",
    items: [
      { id: "introduction", label: "Introduction" },
      { id: "quickstart", label: "Quickstart" },
      { id: "authentication", label: "Authentication" },
    ],
  },
  {
    name: "API reference",
    items: [
      { id: "chat", label: "Chat completions" },
      { id: "streaming", label: "Streaming" },
      { id: "structured", label: "Structured outputs" },
      { id: "tools", label: "Tool calling" },
      { id: "embeddings", label: "Embeddings" },
      { id: "images", label: "Images" },
      { id: "audio", label: "Audio" },
    ],
  },
  {
    name: "Guides",
    items: [
      { id: "errors", label: "Errors" },
      { id: "rate-limits", label: "Rate limits" },
      { id: "regions", label: "Regions & failover" },
    ],
  },
  {
    name: "Resources",
    items: [
      { id: "sdks", label: "SDKs & libraries" },
      { id: "changelog", label: "Changelog" },
    ],
  },
];

/* ---------------------------------------------------------------- helpers */

function Code({ children, label = "bash" }) {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-700/60 bg-[#f4f6ee]">
      <div className="flex items-center justify-between border-b border-ink-700/40 px-3.5 py-2">
        <span className="font-mono text-[9.5px] tracking-[0.18em] text-white/65 uppercase">{label}</span>
        <CopyButton text={children.trim()} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[11.5px] leading-relaxed text-white/85">
        <code>{children.trim()}</code>
      </pre>
    </div>
  );
}

function ParamTable({ rows }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-700/50">
      <table className="w-full min-w-[540px] border-collapse">
        <thead>
          <tr className="border-b border-ink-700/50 bg-ink-800/60">
            {["Parameter", "Type", "Required", "Description"].map((h, i) => (
              <th key={h} className={cn("px-4 py-2.5 font-mono text-[9.5px] font-normal tracking-[0.16em] uppercase", i === 0 ? "text-left" : i === 3 ? "text-left" : "text-center")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, type, req, desc]) => (
            <tr key={name} className="border-b border-ink-700/30 last:border-0">
              <td className="px-4 py-3 font-mono text-[11.5px] text-brand-ember">{name}</td>
              <td className="px-4 py-3 text-center font-mono text-[11px] text-white/65">{type}</td>
              <td className="px-4 py-3 text-center">
                {req ? (
                  <span className="rounded-full border border-brand-coral/40 bg-brand-coral/10 px-2 py-0.5 font-mono text-[9.5px] text-brand-coral uppercase">yes</span>
                ) : (
                  <span className="font-mono text-[10px] text-white/65">no</span>
                )}
              </td>
              <td className="px-4 py-3 text-[12.5px] leading-relaxed text-white/85">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Callout({ tone = "ember", title, children }) {
  const bar = tone === "ember" ? "border-l-brand-ember" : tone === "coral" ? "border-l-brand-coral" : "border-l-brand-lime";
  return (
    <aside className={cn("rounded-r-xl border border-ink-700/40 border-l-4 bg-[#f4f6ee] p-4", bar)}>
      <p className="font-mono text-[10px] tracking-[0.2em] text-white/65 uppercase">{title}</p>
      <div className="mt-2 text-[13px] leading-relaxed text-white/85">{children}</div>
    </aside>
  );
}

function Section({ id, kicker, title, children }) {
  return (
    <section id={id} className="scroll-mt-28 border-b border-ink-700/40 py-10 last:border-0">
      <p className="font-mono text-[10px] tracking-[0.24em] text-brand-coral uppercase">{kicker}</p>
      <h2 className="font-display mt-2 text-2xl font-bold tracking-tight text-white/85 sm:text-[1.7rem]">{title}</h2>
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- page */

export default function DocsPage({ navigate, session }) {
  const [active, setActive] = useState("introduction");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const all = groups.flatMap((g) => g.items);
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-18% 0px -72% 0px", threshold: 0 },
    );
    all.forEach((i) => {
      const el = document.getElementById(i.id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  const filteredGroups = query.trim()
    ? groups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())) }))
        .filter((g) => g.items.length > 0)
    : groups;

  return (
    <div className="relative min-h-screen text-white/85">
      <div className="relative z-10">
        <PageNav navigate={navigate} session={session} />

        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 md:py-16">
          <Reveal>
            <Badge tone="ember">
              <DotmSquare1 size={11} dotSize={2} color="#2447E8" speed={1.2} aria-hidden />
              documentation · v3.2
            </Badge>
          </Reveal>
          <Reveal delay={70}>
            <h1 className="font-display mt-5 max-w-2xl text-[2.2rem] leading-[1.04] font-bold tracking-[-0.02em] text-white/85 sm:text-[2.8rem]">
              Build with RageStar in minutes, run it for years.
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-white/65">
              The RageStar API is OpenAI-compatible. Point an existing SDK at{" "}
              <code className="rounded-md border border-ink-700/40 bg-ink-800/70 px-1.5 py-0.5 font-mono text-[12.5px] text-brand-ember">
                {API_BASE}
              </code>{" "}
              and everything below works unchanged — routing, retries and billing included.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-10 lg:grid-cols-[240px_1fr_220px]">
            {/* sidebar */}
            <aside className="lg:sticky lg:top-24 lg:self-start">
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter pages…"
                  className="w-full rounded-xl border border-ink-700/50 bg-[#f4f6ee] px-3.5 py-2.5 text-[12.5px] text-white/85 placeholder:text-white/65 focus:border-brand-ember/70 focus:outline-none"
                />
              </div>
              {/* mobile: horizontal chips */}
              <div className="mt-4 flex gap-2 overflow-x-auto pb-2 lg:hidden">
                {groups.flatMap((g) => g.items).map((i) => (
                  <a
                    key={i.id}
                    href={`#/docs`}
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById(i.id)?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase",
                      active === i.id ? "border-brand-ember/50 bg-brand-ember/10 text-brand-ember" : "border-ink-700/40 text-white/65",
                    )}
                  >
                    {i.label}
                  </a>
                ))}
              </div>
              <nav className="mt-5 hidden space-y-6 lg:block">
                {filteredGroups.map((g) => (
                  <div key={g.name}>
                    <p className="font-mono text-[9.5px] tracking-[0.22em] text-white/65 uppercase">{g.name}</p>
                    <ul className="mt-2.5 space-y-0.5 border-l border-ink-700/30">
                      {g.items.map((i) => (
                        <li key={i.id}>
                          <a
                            href="#/docs"
                            onClick={(e) => {
                              e.preventDefault();
                              document.getElementById(i.id)?.scrollIntoView({ behavior: "smooth" });
                            }}
                            className={cn(
                              "-ml-px block border-l-2 py-1.5 pl-3.5 text-[13px] transition-all duration-300",
                              active === i.id
                                ? "border-brand-ember font-medium text-brand-ember"
                                : "border-transparent text-white/65 hover:border-ink-700/50 hover:text-white/85",
                            )}
                          >
                            {i.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            </aside>

            {/* content */}
            <div className="min-w-0 max-w-3xl">
              <Section id="introduction" kicker="get started" title="Introduction">
                <p className="text-[14px] leading-relaxed text-white/85">
                  RageStar is a multi-model inference gateway. One base URL serves 40+ models across
                  text, vision, code, embeddings, reranking, image and audio — with per-request
                  routing, automatic failover, streaming and OpenAI-compatible request shapes.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { k: "base url", v: API_HOST },
                    { k: "auth", v: "Bearer key" },
                    { k: "protocol", v: "HTTPS + SSE" },
                  ].map((s) => (
                    <div key={s.k} className="rounded-xl border border-ink-700/50 bg-[#f4f6ee] p-3.5">
                      <div className="font-mono text-[9.5px] tracking-[0.18em] text-white/65 uppercase">{s.k}</div>
                      <div className="mt-1 font-mono text-[12.5px] text-white/85">{s.v}</div>
                    </div>
                  ))}
                </div>
                <Callout title="Compatibility">
                  Any OpenAI SDK works unmodified — set <code className="font-mono text-[12px]">base_url</code> to RageStar and
                  keep your existing parsing code. Vendor-specific extensions (log-probs, usage
                  breakdown, region hints) come back as extra fields you can ignore safely.
                </Callout>
              </Section>

              <Section id="quickstart" kicker="get started" title="Quickstart">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Three steps to a streaming completion: create a key in the console, export it, and
                  send your first request. Median time-to-first-token is 184 ms on the default route.
                </p>
                <Code label="terminal">{`# 1. create a key at console.ragestar.ai → API keys
export RAGESTAR_API_KEY="sk_live_4f9c8b21..."

# 2. your first request
curl ${API_BASE}/chat/completions \\
  -H "Authorization: Bearer $RAGESTAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "ragestar-4-mini",
    "messages": [{ "role": "user", "content": "Say hello in 3 languages." }],
    "stream": true
  }'`}</Code>
                <CodeTabs modelId="ragestar-4-mini" />
              </Section>

              <Section id="authentication" kicker="get started" title="Authentication">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Every request is authenticated with a scoped API key sent as a bearer token. Keys
                  are scoped per environment (<code className="font-mono text-[12.5px]">sk_live_…</code> /{" "}
                  <code className="font-mono text-[12.5px]">sk_test_…</code>) and per capability, so a
                  leaked playground key can't write embeddings or admin settings.
                </p>
                <Code label="http">{`GET /v1/models HTTP/1.1
Host: ${API_HOST}
Authorization: Bearer sk_live_4f9c8b21...
X-RageStar-Region: eu-west-1        # optional region pin
X-Request-Id: 7f2a-11c            # optional trace id`}</Code>
                <Callout tone="coral" title="Rotate regularly">
                  Keys can be rotated from the console with zero downtime — the old key stays valid
                  for 24 hours after rotation. Full secrets are shown exactly once at creation.
                </Callout>
              </Section>

              <Section id="chat" kicker="api reference" title="Chat completions">
                <p className="text-[14px] leading-relaxed text-white/85">
                  <code className="font-mono text-[12.5px] text-brand-ember">POST /v1/chat/completions</code> —
                  the workhorse endpoint. Accepts system / user / assistant / tool messages and
                  returns one or many choices.
                </p>
                <ParamTable
                  rows={[
                    ["model", "string", true, "Model id from the catalog, e.g. ragestar-4-turbo or ragestar-4-mini."],
                    ["messages", "array", true, "Ordered conversation. Roles: system, user, assistant, tool."],
                    ["temperature", "number", false, "Sampling temperature 0–2. Defaults to 1. Lower for extraction, higher for drafting."],
                    ["top_p", "number", false, "Nucleus sampling cutoff. Use temperature or top_p, not both."],
                    ["max_tokens", "integer", false, "Hard cap on generated tokens. Billed only for tokens actually produced."],
                    ["stream", "boolean", false, "SSE stream of partial deltas instead of one JSON body."],
                    ["response_format", "object", false, "text, json_object, or a strict json_schema (see Structured outputs)."],
                    ["tools", "array", false, "Function definitions the model may call (see Tool calling)."],
                    ["seed", "integer", false, "Deterministic sampling hint. Same seed + prompt ≈ same output."],
                    ["user", "string", false, "End-user id used for abuse monitoring. Never sends PII upstream."],
                  ]}
                />
                <Code label="response · 200">{`{
  "id": "chatcmpl_9f21c",
  "object": "chat.completion",
  "model": "ragestar-4-mini",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello! Bonjour! Hola!" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 24, "completion_tokens": 11, "total_tokens": 35 },
  "ragestar": { "region": "us-east-1", "ttft_ms": 96, "routed_via": "direct" }
}`}</Code>
              </Section>

              <Section id="streaming" kicker="api reference" title="Streaming">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Set <code className="font-mono text-[12.5px]">stream: true</code> to receive
                  server-sent events. The first event arrives as soon as prefill finishes —
                  typically under 200 ms — and usage is reported in the final event.
                </p>
                <Code label="sse">{`data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}],
       "usage":{"prompt_tokens":24,"completion_tokens":2},
       "ragestar":{"ttft_ms":96,"tok_per_s":241}}

data: [DONE]`}</Code>
                <Callout tone="lime" title="Partial tool calls">
                  When streaming with tools, function arguments arrive as cumulative fragments in
                  <code className="font-mono text-[12px]"> delta.tool_calls[].function.arguments</code> —
                  append them, then parse once at <code className="font-mono text-[12px]">finish_reason: "tool_calls"</code>.
                </Callout>
              </Section>

              <Section id="structured" kicker="api reference" title="Structured outputs">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Constrain decoding to a JSON schema. With <code className="font-mono text-[12.5px]">strict: true</code>{" "}
                  the output is guaranteed to validate — no retry loops, no regex scrubbing.
                </p>
                <Code label="request">{`{
  "model": "ragestar-4-mini",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "ticket_triage",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "severity": { "enum": ["low", "high", "critical"] },
          "summary":  { "type": "string" },
          "team":     { "enum": ["payments", "auth", "data"] }
        },
        "required": ["severity", "summary", "team"]
      }
    }
  },
  "messages": [{ "role": "user", "content": "..." }]
}`}</Code>
              </Section>

              <Section id="tools" kicker="api reference" title="Tool calling">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Declare functions as tools; the model returns typed arguments instead of prose.
                  Parallel tool calls are supported — execute them concurrently and feed results
                  back as <code className="font-mono text-[12.5px]">role: "tool"</code> messages.
                </p>
                <Code label="request">{`"tools": [{
  "type": "function",
  "function": {
    "name": "get_order_status",
    "description": "Look up the fulfilment status of an order.",
    "parameters": {
      "type": "object",
      "properties": { "order_id": { "type": "string" } },
      "required": ["order_id"]
    }
  }
}],
"tool_choice": "auto"`}</Code>
              </Section>

              <Section id="embeddings" kicker="api reference" title="Embeddings">
                <p className="text-[14px] leading-relaxed text-white/85">
                  <code className="font-mono text-[12.5px] text-brand-ember">POST /v1/embeddings</code> —
                  batch up to 96 inputs per call. Vectors are returned normalized; store them as-is
                  and use cosine or inner-product search.
                </p>
                <ParamTable
                  rows={[
                    ["model", "string", true, "ragestar-rerank-v2 (1024 dims) for embeddings and reranking."],
                    ["input", "string | array", true, "Text or up to 96 texts per request."],
                    ["dimensions", "integer", false, "Truncate to 256 / 512 / 1024 dims. Cheaper and nearly lossless for search."],
                  ]}
                />
                <Code label="rerank">{`POST /v1/rerank
{ "model": "ragestar-rerank-v2", "query": "...", "documents": ["...", "..."], "top_n": 5 }
→ { "results": [{ "index": 2, "relevance": 0.94 }, ...] }`}</Code>
              </Section>

              <Section id="images" kicker="api reference" title="Images">
                <p className="text-[14px] leading-relaxed text-white/85">
                  <code className="font-mono text-[12.5px] text-brand-ember">POST /v1/images/generations</code>{" "}
                  is the text-to-image endpoint. Billed per image, four diffusion steps, commercially
                  safe outputs with embedded provenance metadata.
                </p>
                <Code label="request">{`{ "prompt": "isometric server rack, blueprint style",
  "size": "1024x1024", "n": 1, "response_format": "url" }`}</Code>
              </Section>

              <Section id="audio" kicker="api reference" title="Audio">
                <p className="text-[14px] leading-relaxed text-white/85">
                  <code className="font-mono text-[12.5px] text-brand-ember">POST /v1/audio/transcriptions</code>{" "}
                  is the speech-to-text endpoint. Multipart upload, word-level timestamps and optional
                  speaker diarization. Billed per audio minute.
                </p>
                <Code label="terminal">{`curl ${API_BASE}/audio/transcriptions \\
  -H "Authorization: Bearer $RAGESTAR_API_KEY" \\
  -F file=@meeting.m4a -F word_timestamps=true`}</Code>
              </Section>

              <Section id="errors" kicker="guides" title="Errors">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Errors return a stable machine-readable <code className="font-mono text-[12.5px]">code</code>,
                  a human <code className="font-mono text-[12.5px]">message</code>, and a{" "}
                  <code className="font-mono text-[12.5px]">request_id</code> for support traces.
                </p>
                <ParamTable
                  rows={[
                    ["400", "invalid_request_error", false, "Malformed body or unsupported parameter. Fix and retry immediately."],
                    ["401", "authentication_error", false, "Missing or revoked key. Check the Authorization header."],
                    ["403", "permission_error", false, "Key scope doesn't cover this endpoint or model."],
                    ["404", "model_not_found", false, "Unknown model id, or the model is disabled in your org."],
                    ["408", "timeout_error", false, "Prefill exceeded 60 s. Shorten the prompt or use a faster model."],
                    ["429", "rate_limit_error", false, "Over rpm/tpm limit. Honour Retry-After; back off exponentially."],
                    ["500", "server_error", false, "Rare platform fault. Safe to retry with the same request."],
                    ["503", "overloaded_error", false, "Model saturated. Retry — routing will try another replica."],
                  ]}
                />
                <Callout tone="coral" title="Idempotency">
                  Send <code className="font-mono text-[12px]">Idempotency-Key</code> on POST requests you may retry;
                  duplicate keys within 24 h return the original response instead of double-billing.
                </Callout>
              </Section>

              <Section id="rate-limits" kicker="guides" title="Rate limits">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Limits are per organization and per model, returned in every response header:{" "}
                  <code className="font-mono text-[12.5px]">x-ragestar-rpm-remaining</code>,{" "}
                  <code className="font-mono text-[12.5px]">x-ragestar-tpm-remaining</code>,{" "}
                  <code className="font-mono text-[12.5px]">x-ragestar-reset</code>.
                </p>
                <ParamTable
                  rows={[
                    ["Developer", "rpm", false, "60 requests/min · 200k tokens/min · burst ×2 for 10 s."],
                    ["Scale", "rpm", false, "2,000 requests/min · 4M tokens/min · burst ×3, self-serve raises."],
                    ["Enterprise", "rpm", false, "Custom ceilings, per-region quotas, dedicated capacity pools."],
                  ]}
                />
              </Section>

              <Section id="regions" kicker="guides" title="Regions & failover">
                <p className="text-[14px] leading-relaxed text-white/85">
                  Requests land in the healthiest region by default. Pin one with{" "}
                  <code className="font-mono text-[12.5px]">X-RageStar-Region</code> or the console if
                  data-residency requires it. If a shard degrades mid-stream, the request fails over
                  to a healthy replica with the same response contract.
                </p>
                <ParamTable
                  rows={[
                    ["us-east-1", "region", false, "N. Virginia · general purpose · p50 168 ms."],
                    ["us-west-2", "region", false, "Oregon · image generation hub · p50 176 ms."],
                    ["eu-west-1", "region", false, "Ireland · EU data boundary · p50 184 ms."],
                    ["eu-central-1", "region", false, "Frankfurt · dedicated Enterprise clusters · p50 151 ms."],
                    ["ap-south-1", "region", false, "Mumbai · lowest latency for South Asia · p50 242 ms."],
                  ]}
                />
              </Section>

              <Section id="sdks" kicker="resources" title="SDKs & libraries">
                <p className="text-[14px] leading-relaxed text-white/85">
                  First-party SDKs wrap the REST API with typed responses, automatic retries and
                  streaming iterators. Because the surface is OpenAI-compatible, the OpenAI SDKs
                  also work with a base-URL override.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { k: "python", v: "pip install ragestar-sdk" },
                    { k: "typescript", v: "npm i @ragestar/sdk" },
                    { k: "go", v: "go get github.com/ragestar-ai/ragestar-go" },
                    { k: "rust", v: "cargo add ragestar-rs" },
                  ].map((s) => (
                    <div key={s.k} className="flex items-center justify-between gap-3 rounded-xl border border-ink-700/50 bg-[#f4f6ee] px-4 py-3">
                      <span className="font-mono text-[11px] tracking-[0.14em] text-white/65 uppercase">{s.k}</span>
                      <code className="truncate font-mono text-[11.5px] text-brand-ember">{s.v}</code>
                    </div>
                  ))}
                </div>
              </Section>

              <Section id="changelog" kicker="resources" title="Changelog">
                <ol className="relative space-y-6 border-l border-ink-700/30 pl-6">
                  {[
                    { v: "v3.2.0", d: "Jun 2026", notes: ["Streaming tool-call fragments", "ragestar-4-mini context → 128k", "ap-southeast-1 region (private beta)"] },
                    { v: "v3.1.0", d: "May 2026", notes: ["Strict json_schema outputs", "Idempotency-Key support", "Per-model tpm headers"] },
                    { v: "v3.0.0", d: "Apr 2026", notes: ["Multi-region failover v2", "ragestar-rerank-v2 GA", "Usage API & cost attribution"] },
                    { v: "v2.7.1", d: "Mar 2026", notes: ["Batch API 50% discount window", "Zero-retention toggle per key"] },
                  ].map((c) => (
                    <li key={c.v} className="relative">
                      <span className="absolute -left-[27.5px] top-1.5 h-2 w-2 rounded-full border-2 border-ink-950 bg-brand-ember" />
                      <p className="flex items-baseline gap-3">
                        <span className="font-mono text-[12.5px] font-bold text-white/85">{c.v}</span>
                        <span className="font-mono text-[10.5px] tracking-[0.14em] text-white/65 uppercase">{c.d}</span>
                      </p>
                      <ul className="mt-1.5 space-y-1 text-[13px] text-white/65">
                        {c.notes.map((n) => (
                          <li key={n}>— {n}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </Section>

              <div className="mt-10 flex flex-wrap gap-3">
                <button
                  onClick={() => navigate(session ? "dashboard/playground" : "signup")}
                  className="rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-6 py-3 text-[13px] font-medium text-ink-950 transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.4)]"
                  style={{ color: "#e9ece4" }}
                >
                  Try it in the playground
                </button>
                <button
                  onClick={() => navigate("models")}
                  className="rounded-full border border-ink-700/60 bg-ink-800/70 px-6 py-3 text-[13px] font-medium text-white/85 transition-colors hover:border-brand-ember/60"
                >
                  Browse the model catalog
                </button>
              </div>
            </div>

            {/* right rail: on this page */}
            <aside className="hidden xl:block">
              <div className="sticky top-24 rounded-2xl border border-ink-700/40 bg-[#f4f6ee] p-4">
                <p className="font-mono text-[9.5px] tracking-[0.22em] text-white/65 uppercase">reading</p>
                <p className="font-display mt-2 text-[14px] font-semibold text-white/85">
                  {groups.flatMap((g) => g.items).find((i) => i.id === active)?.label ?? "Introduction"}
                </p>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-700/20">
                  <div
                    className="h-full bg-gradient-to-r from-brand-ember to-brand-coral transition-all duration-500"
                    style={{ width: `${((groups.flatMap((g) => g.items).findIndex((i) => i.id === active) + 1) / 15) * 100}%` }}
                  />
                </div>
                <a href="#/status" className="mt-4 block font-mono text-[10px] tracking-[0.16em] text-brand-ember uppercase hover:underline">
                  live status →
                </a>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
