import { useEffect, useMemo, useRef, useState } from "react";
import { contextLabel } from "./data.js";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { CopyButton } from "./models.jsx";
import { cn } from "../lib/cn.js";
import { streamGateway } from "../../lib/db.js";
import { GATEWAY_URL } from "../../lib/config.js";
import { API_BASE } from "../lib/gateway.js";
import { useCatalog } from "../lib/workspace.js";

const presets = [
  "Explain vector search in two sentences.",
  "Turn this support ticket into JSON with severity + summary.",
  "Write a SQL query for 7-day retention by cohort.",
  "Summarise our API changelog for a non-technical exec.",
];

/** Canned completions so the demo streams something plausible per prompt. */
function craftReply(prompt, modelName) {
  const p = prompt.toLowerCase();
  if (p.includes("json") || p.includes("schema"))
    return `Here is a structured extraction using the \`json_object\` response format:\n\n\`\`\`json\n{\n  "summary": "Customer cannot complete checkout; card declines on 3DS step.",\n  "severity": "high",\n  "product_area": "payments",\n  "sentiment": "frustrated",\n  "entities": { "account_id": "acct_8812", "order_value_usd": 249.0 },\n  "suggested_reply": "We have escalated this to payments engineering and added a temporary bypass."\n}\n\`\`\`\n\nPass \`response_format: { type: "json_schema" }\` and the schema to guarantee the shape at decode time — no retry loop needed.`;
  if (p.includes("sql") || p.includes("query"))
    return `Assuming a \`sessions(user_id, started_at)\` table and a 7-day acquisition window:\n\n\`\`\`sql\nWITH cohorts AS (\n  SELECT user_id, date_trunc('day', started_at) AS cohort_day\n  FROM sessions GROUP BY 1, 2\n),\nactivity AS (\n  SELECT c.cohort_day, c.user_id,\n         extract('day' FROM s.started_at - c.cohort_day) AS day_index\n  FROM cohorts c JOIN sessions s USING (user_id)\n)\nSELECT cohort_day,\n       day_index,\n       count(DISTINCT user_id) AS active,\n       round(100.0 * count(DISTINCT user_id) /\n         first_value(count(DISTINCT user_id)) OVER (\n           PARTITION BY cohort_day ORDER BY day_index\n         ), 1) AS retention_pct\nFROM activity\nWHERE day_index BETWEEN 0 AND 6\nGROUP BY 1, 2\nORDER BY 1, 2;\n\`\`\`\n\nIndex on \`(user_id, started_at)\` keeps this under 200 ms at a few million rows.`;
  if (p.includes("summar") || p.includes("changelog"))
    return `**What shipped this week**\n\n- Streaming tool calls now emit partial arguments, so you can render UI skeletons mid-call.\n- \`ragestar-4-mini\` got a 4× longer context window at the same price per token.\n- New \`ap-southeast-1\` region reduces p50 latency for Southeast Asia by about 60 ms.\n\n**What to change in your code**\n\n1. Nothing is breaking — the API is version-pinned.\n2. Opt into the new region with \`region: "ap-southeast-1"\`.\n3. If you parse streamed tool calls manually, read \`delta.tool_calls[].function.arguments\` cumulatively.`;
  if (p.includes("vector") || p.includes("embedding"))
    return `Vector search maps text into a high-dimensional space where semantically similar meaning sits close together, so nearest-neighbour lookups return conceptually related passages rather than keyword matches.\n\nIn practice you embed your corpus once, store the vectors in an index such as HNSW, then embed each query at request time and retrieve the top-k neighbours before passing them to ${modelName} as grounding context.`;
  return `Good question. Here is how I would approach it with ${modelName}:\n\n1. **Reduce the problem space first.** Most quality wins come from better context selection, not a bigger model — retrieve 3–5 precise passages instead of stuffing 40.\n2. **Constrain the output.** A JSON schema or a short few-shot block usually removes the need for retries.\n3. **Measure time-to-first-token, not total latency.** Perceived speed is dominated by the first visible token, which streams here in well under 400 ms.\n\nIf you share the failing input, I can point at the specific step that is degrading.`;
}

/** Splits text into renderable blocks: fenced code and prose. */
function RichText({ text }) {
  const blocks = text.split(/```/g);
  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          const [maybeLang, ...rest] = block.split("\n");
          const body = rest.length ? rest.join("\n") : maybeLang;
          return (
            <div key={i} className="overflow-hidden rounded-xl border border-white/10 bg-ink-950/80">
              <div className="flex items-center justify-between border-b border-white/8 px-3 py-1.5">
                <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">
                  {rest.length ? maybeLang.trim() || "code" : "code"}
                </span>
                <CopyButton text={body.trim()} label="Copy" />
              </div>
              <pre className="overflow-x-auto p-3.5 font-mono text-[11.5px] leading-relaxed text-white/75">
                <code>{body.trim()}</code>
              </pre>
            </div>
          );
        }
        if (!block.trim()) return null;
        return (
          <div key={i} className="space-y-2 text-[13.5px] leading-relaxed text-white/70">
            {block
              .split("\n")
              .filter((l) => l.trim())
              .map((line, li) => {
                const bold = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
                if (/^\s*[-•]\s/.test(line) || /^\s*\d+\.\s/.test(line))
                  return (
                    <p key={li} className="flex gap-2.5" dangerouslySetInnerHTML={{ __html: bold }} />
                  );
                return <p key={li} dangerouslySetInnerHTML={{ __html: bold }} />;
              })}
          </div>
        );
      })}
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, format = (v) => String(v) }) {
  return (
    <label className="block">
      <span className="flex items-center justify-between">
        <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-white/75">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[#2447E8]"
        style={{ accentColor: "#2447E8" }}
      />
    </label>
  );
}

export default function Playground({ initialModel, initialKey = "", ws }) {
  /* Live catalog only. It used to fall back to the kit's fixture list, which
     meant the picker offered models and then silently rearranged itself once
     the real catalog landed. */
  const catalog = useCatalog();
  const models = catalog ?? [];
  const [modelId, setModelId] = useState(initialModel ?? null);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.95);
  const [maxTokens, setMaxTokens] = useState(512);
  const [system, setSystem] = useState("You are a concise technical assistant for an AI platform team.");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /* The gateway key the playground calls with. Held in component state ONLY —
     never written to localStorage: a long-lived bearer credential does not
     belong in a store that any script on the origin can read. Empty means
     "run the canned demo", which is also the honest state for a fresh install. */
  const [apiKey, setApiKey] = useState(initialKey);
  const [liveError, setLiveError] = useState(null);
  const [stats, setStats] = useState(null);
  const timer = useRef(null);
  const scroller = useRef(null);
  const abort = useRef(null);

  /* Default to the first catalog model; keep a stale/removed id from breaking
     the lookup, and follow `initialModel` when the catalog navigates here. */
  const model = useMemo(
    () => models.find((m) => m.id === modelId) ?? models[0],
    [modelId, models],
  );

  useEffect(() => {
    if (initialModel) setModelId(initialModel);
  }, [initialModel]);

  /* A key handed over from the Keys view after this panel mounted — follow it
     so the very next prompt is a live gateway call. */
  useEffect(() => {
    if (initialKey) setApiKey(initialKey);
  }, [initialKey]);

  useEffect(() => {
    if (models.length && !models.some((m) => m.id === modelId)) setModelId(models[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current);
    abort.current?.abort();
  }, []);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    });
  };

  /* The pre-written reply, typed out on a timer. Used when there is no gateway
     key to call with — a fresh install, or someone just looking around. */
  const runDemo = (prompt) => {
    const reply = craftReply(prompt, model.name);
    const tokens = reply.match(/\s+/g)?.length ?? 40;
    const ttft = Math.max(120, (model.ttft ?? 180) + Math.round(Math.random() * 60));
    const started = performance.now();
    let i = 0;
    const perTick = Math.max(2, Math.round(tokens / 34));

    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      i += perTick;
      const slice = reply.slice(0, Math.floor((i / tokens) * reply.length));
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: slice, streaming: true };
        return copy;
      });
      scrollDown();
      if (i >= tokens) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: reply };
          return copy;
        });
        setStats({
          ttft,
          tokens: Math.max(1, Math.round(tokens * 1.02)),
          total: Math.round(performance.now() - started),
        });
        setBusy(false);
        scrollDown();
      }
    }, 55);
  };

  const send = async (text) => {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    setStats(null);
    setLiveError(null);
    setMessages([...messages, { role: "user", content: prompt }, { role: "assistant", content: "", streaming: true }]);
    scrollDown();

    if (!apiKey.trim() || !GATEWAY_URL) {
      runDemo(prompt);
      return;
    }

    /* Real call: the same POST /chat/completions an OpenAI SDK would make,
       read as SSE. */
    const controller = new AbortController();
    abort.current = controller;
    let acc = "";
    try {
      const result = await streamGateway({
        apiKey,
        model: model.id,
        messages: [{ role: "system", content: system }, ...messages, { role: "user", content: prompt }],
        temperature,
        topP,
        maxTokens,
        signal: controller.signal,
        onDelta: (delta) => {
          acc += delta;
          setMessages((prev) => {
            const copy = [...prev];
            copy[copy.length - 1] = { role: "assistant", content: acc, streaming: true };
            return copy;
          });
          scrollDown();
        },
      });
      setMessages((prev) => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: "assistant", content: acc };
        return copy;
      });
      setStats({ ...result, live: true });
      /* The router writes the log row when the stream flushes, so by now it
         exists. Pull the workspace again or the Requests and Usage screens
         keep showing the pre-playground list until a manual reload. */
      ws?.refresh?.();
    } catch (err) {
      if (err?.name === "AbortError") {
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", content: acc };
          return copy;
        });
      } else {
        setLiveError(err?.message || "The gateway call failed.");
        /* Drop the empty bubble; keep whatever already streamed in. */
        setMessages((prev) =>
          acc ? [...prev.slice(0, -1), { role: "assistant", content: acc }] : prev.slice(0, -1),
        );
      }
    } finally {
      abort.current = null;
      setBusy(false);
      scrollDown();
    }
  };

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setMessages((prev) => prev.map((m) => ({ ...m, streaming: false })));
  };

  const estimate = Math.max(1, Math.round((system.length + input.length + messages.reduce((a, m) => a + m.content.length, 0)) / 4));

  /* The catalog is live and empty: an admin has not published a model yet. */
  if (!model) {
    return (
      <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-10 text-center">
        <p className="font-display text-[15px] font-semibold text-white">No models published yet</p>
        <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-relaxed text-white/45">
          An admin needs to map at least one public model id in the model mapping section before the
          playground can call anything.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[300px_1fr]">
      {/* configuration rail */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
          <h2 className="font-display text-[13px] font-semibold tracking-wide text-white uppercase">Model</h2>
          <select
            value={modelId ?? ""}
            onChange={(e) => setModelId(e.target.value)}
            className="mt-3 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3 py-2.5 text-[12.5px] text-white focus:border-brand-ember/60 focus:outline-none"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id} className="bg-ink-900">
                {m.name}
              </option>
            ))}
          </select>
          <dl className="mt-4 grid grid-cols-2 gap-3">
            {[
              { k: "context", v: contextLabel(model.context) },
              { k: "ttft", v: model.ttft ? `${model.ttft}ms` : "—" },
              { k: "in / 1M", v: `$${model.priceIn}` },
              { k: "out / 1M", v: `$${model.priceOut}` },
            ].map((s) => (
              <div key={s.k} className="rounded-xl border border-white/8 bg-white/[0.03] p-2.5">
                <dt className="font-mono text-[9px] tracking-[0.14em] text-white/40 uppercase">{s.k}</dt>
                <dd className="mt-1 font-mono text-[11.5px] text-white/85">{s.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-5">
          <h2 className="font-display text-[13px] font-semibold tracking-wide text-white uppercase">
            Gateway key
          </h2>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="rs_live_…"
            autoComplete="off"
            spellCheck={false}
            className="mt-3 w-full rounded-xl border border-white/10 bg-ink-950/70 px-3 py-2.5 font-mono text-[12px] text-white placeholder:text-white/30 focus:border-brand-ember/60 focus:outline-none"
          />
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-white/40">
            {GATEWAY_URL
              ? apiKey.trim()
                ? "Live: streaming from your gateway. The key stays in memory — it is never written to storage."
                : "No key — replies are pre-written samples. Paste an rs_live_ key to call the gateway for real."
              : "No gateway URL configured. Replies are pre-written samples."}
          </p>
        </section>

        <section className="space-y-5 rounded-2xl border border-white/8 bg-white/[0.025] p-5">
          <h2 className="font-display text-[13px] font-semibold tracking-wide text-white uppercase">Parameters</h2>
          <Slider label="temperature" value={temperature} min={0} max={2} step={0.05} onChange={setTemperature} format={(v) => v.toFixed(2)} />
          <Slider label="top_p" value={topP} min={0.1} max={1} step={0.01} onChange={setTopP} format={(v) => v.toFixed(2)} />
          <Slider label="max tokens" value={maxTokens} min={64} max={4096} step={64} onChange={setMaxTokens} />
          <label className="block">
            <span className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">system prompt</span>
            <textarea
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              rows={4}
              className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-ink-950/70 p-3 text-[12px] leading-relaxed text-white/80 focus:border-brand-ember/60 focus:outline-none"
            />
          </label>
          <div className="rounded-xl border border-white/8 bg-white/[0.03] p-3">
            <div className="font-mono text-[9.5px] tracking-[0.14em] text-white/40 uppercase">est. input tokens</div>
            <div className="mt-1 font-mono text-[13px] tabular-nums text-white/85">~{estimate}</div>
          </div>
        </section>
      </div>

      {/* chat surface */}
      <section className="flex min-h-[560px] flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.02]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-lime-400" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-lime-400" />
            </span>
            <span className="font-mono text-[11px] tracking-[0.14em] text-white/60 uppercase">
              {model.id} · stream
            </span>
          </div>
          <div className="flex items-center gap-2">
            {stats && (
              <span className="hidden font-mono text-[10.5px] text-white/40 sm:block">
                ttft {stats.ttft}ms · {stats.tokens}
                {stats.tokensEstimated ? " tok (est.)" : " tok"} ·{" "}
                {(stats.tokens / (stats.total / 1000)).toFixed(0)} tok/s
              </span>
            )}
            <CopyButton
              text={`curl ${API_BASE}/chat/completions -H "Authorization: Bearer $RAGESTAR_API_KEY" -H "Content-Type: application/json" -d '{"model":"${model.id}","temperature":${temperature},"top_p":${topP},"max_tokens":${maxTokens},"messages":[{"role":"system","content":${JSON.stringify(system)}}]}'`}
              label="Copy as cURL"
            />
            <button
              onClick={() => {
                setMessages([]);
                setStats(null);
              }}
              className="rounded-full border border-white/12 bg-white/[0.05] px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-white/60 uppercase transition-colors hover:text-white"
            >
              Clear
            </button>
          </div>
        </header>

        <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto p-5">
          {liveError ? (
            <p className="rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12.5px] text-rose-100">
              Gateway call failed — {liveError}
            </p>
          ) : null}

          {messages.length === 0 && (
            <div className="mx-auto max-w-xl py-8 text-center">
              <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-orange-500 via-red-500 to-rose-500">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-white" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M12 3.2 21 19.4H3L12 3.2Z" strokeLinejoin="round" />
                </svg>
              </span>
              <h3 className="font-display mt-5 text-lg font-semibold tracking-tight text-white">
                Send a prompt to {model.name}
              </h3>
              <p className="mt-2 text-[13px] text-white/50">
                {apiKey.trim() && GATEWAY_URL
                  ? "Streaming from your gateway, with live time-to-first-token and throughput."
                  : "Sample replies stream token-by-token. Add a gateway key to call the real thing."}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {presets.map((p) => (
                  <button
                    key={p}
                    onClick={() => send(p)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-left text-[12px] text-white/65 transition-colors hover:border-brand-ember/35 hover:text-white"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={cn("flex gap-3", m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "assistant" && (
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-orange-500 via-red-500 to-rose-500">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M12 3.2 21 19.4H3L12 3.2Z" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              <div
                className={cn(
                  "max-w-[86%] rounded-2xl px-4 py-3.5",
                  m.role === "user"
                    ? "border border-white/12 bg-white/[0.06] text-[13.5px] text-white/90"
                    : "border border-white/8 bg-white/[0.025]",
                )}
              >
                {m.role === "user" ? (
                  m.content
                ) : (
                  <>
                    <RichText text={m.content} />
                    {m.streaming && (
                      <span className="mt-1 inline-block h-4 w-[2px] animate-pulse bg-brand-ember align-middle" />
                    )}
                  </>
                )}
              </div>
            </div>
          ))}

          {busy && messages[messages.length - 1]?.content === "" && (
            <div className="flex items-center gap-3 pl-11 font-mono text-[11px] tracking-[0.16em] text-white/40 uppercase">
              <DotmSquare1 size={16} dotSize={2} color="#2447E8" speed={1.5} aria-hidden />
              routing to {model.provider} · prefilling
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="border-t border-white/8 p-4"
        >
          <div className="flex items-end gap-3">
            <div className="relative flex-1">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder={`Message ${model.name}…  (⏎ to send, ⇧⏎ for newline)`}
                className="w-full resize-none rounded-2xl border border-white/10 bg-ink-950/70 px-4 py-3 text-[13px] text-white placeholder:text-white/35 focus:border-brand-ember/60 focus:outline-none"
              />
            </div>
            {busy ? (
              <button
                type="button"
                onClick={stop}
                className="rounded-2xl border border-rose-400/30 bg-rose-500/12 px-5 py-3.5 text-[13px] text-rose-100 transition-colors hover:bg-rose-500/20"
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="rounded-2xl bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3.5 text-[13px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Run
              </button>
            )}
          </div>
          <p className="mt-2.5 font-mono text-[10px] tracking-[0.12em] text-white/30 uppercase">
            simulated stream · tokens billed at ${model.priceIn} / ${model.priceOut} per 1M · max {maxTokens}
          </p>
        </form>
      </section>
    </div>
  );
}
