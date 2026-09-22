import { useMemo, useState } from "react";
import { contextLabel, modelFilters, priceLabel } from "./data.js";
import { cn } from "../lib/cn.js";
import { useCatalog } from "../lib/useCatalog.js";
import { API_BASE } from "../lib/gateway.js";

export function CopyButton({ text, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.05] px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] text-white/65 uppercase transition-colors hover:bg-white/10 hover:text-white"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.7">
        {done ? (
          <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M9 9h9v9H9V9Zm-3 6H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V6" strokeLinecap="round" />
        )}
      </svg>
      {done ? "Copied" : label}
    </button>
  );
}


export function CodeTabs({ modelId }) {
  const [tab, setTab] = useState("curl");
  const snippets = {
    curl: `curl ${API_BASE}/chat/completions \\
  -H "Authorization: Bearer $RAGESTAR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "stream": true,
    "messages": [
      { "role": "system", "content": "You are a concise technical assistant." },
      { "role": "user", "content": "Explain vector search in two sentences." }
    ]
  }'`,
    python: `from ragestar import RageStar

client = RageStar()  # reads RAGESTAR_API_KEY

stream = client.chat.completions.create(
    model="${modelId}",
    stream=True,
    messages=[
        {"role": "system", "content": "You are a concise technical assistant."},
        {"role": "user", "content": "Explain vector search in two sentences."},
    ],
)

for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`,
    ts: `import RageStar from "@ragestar/sdk";

const ragestar = new RageStar({ apiKey: process.env.RAGESTAR_API_KEY! });

const stream = await ragestar.chat.completions.create({
  model: "${modelId}",
  stream: true,
  messages: [
    { role: "system", content: "You are a concise technical assistant." },
    { role: "user", content: "Explain vector search in two sentences." },
  ],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`,
  };

  
return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-ink-950/80">
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-3 py-2">
        <div className="flex gap-1">
          {["curl", "python", "ts"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-full px-3 py-1 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-colors",
                tab === t ? "bg-white/90 text-ink-950" : "text-white/45 hover:text-white",
              )}
            >
              {t === "curl" ? "cURL" : t === "ts" ? "TypeScript" : "Python"}
            </button>
          ))}
        </div>
        <CopyButton text={snippets[tab]} label="Copy snippet" />
      </div>
      <pre className="max-h-[300px] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed text-white/75">
        <code>{snippets[tab]}</code>
      </pre>
    </div>
  );
}


const statusTone = {
  ga: "text-lime-300 border-lime-400/25 bg-lime-500/10",
  beta: "text-amber-200 border-amber-400/25 bg-amber-500/10",
  preview: "text-rose-200 border-rose-400/25 bg-rose-500/10",
};

function PriceCell({ model }) {
  if (model.modality.includes("image") || model.modality.includes("audio"))
    return (
      <div className="font-mono text-[12px] text-white/80">
        {priceLabel(model.priceIn)}
        <span className="text-white/35"> / call</span>
      </div>
    );
  if (model.modality.includes("embedding") || model.modality.includes("rerank"))
    return (
      <div className="font-mono text-[12px] text-white/80">
        {priceLabel(model.priceIn)}
        <span className="text-white/35"> / 1M tok</span>
      </div>
    );
  return (
    <div className="font-mono text-[12px] text-white/80">
      {priceLabel(model.priceIn)}
      <span className="text-white/35"> in</span>
      <span className="mx-1 text-white/20">·</span>{priceLabel(model.priceOut)}
      <span className="text-white/35"> out</span>
    </div>
  );
}


function ModelCard({ model, onSelect, onTry }) {
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-white/[0.025] p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-ember/35 hover:bg-white/[0.045]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display truncate text-[15.5px] font-semibold tracking-tight text-white">
            {model.name}
          </h3>
          <p className="mt-0.5 font-mono text-[10.5px] tracking-[0.1em] text-white/40">
            {model.provider} · {model.id}
          </p>
        </div>
        <span className={cn("shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9.5px] tracking-[0.14em] uppercase", statusTone[model.status])}>
          {model.status}
        </span>
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-white/55">{model.blurb}</p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {model.modality.map((m) => (
          <span key={m} className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[9.5px] tracking-[0.12em] text-white/55 uppercase">
            {m}
          </span>
        ))}
        {model.license === "Open weights" && (
          <span className="rounded-full border border-lime-400/25 bg-lime-500/10 px-2 py-0.5 font-mono text-[9.5px] tracking-[0.12em] text-lime-300 uppercase">
            open
          </span>
        )}
      </div>

      
<dl className="mt-4 grid grid-cols-2 gap-3 border-t border-white/8 pt-4">
        <div>
          <dt className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">context</dt>
          <dd className="mt-1 font-mono text-[12.5px] text-white/85">
            {contextLabel(model.context)}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">ttft</dt>
          <dd className="mt-1 font-mono text-[12.5px] text-white/85">
            {model.ttft ? `${model.ttft}ms` : "—"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">price</dt>
          <dd className="mt-1">
            <PriceCell model={model} />
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={onTry}
          className="flex-1 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-4 py-2.5 text-[12.5px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)]"
        >
          Try in playground
        </button>
        <button
          onClick={onSelect}
          className="rounded-full border border-white/12 bg-white/5 px-4 py-2.5 text-[12.5px] text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          Details
        </button>
      </div>
    </article>
  );
}


function ModelDetail({ model, onClose, onTry }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Ink scrim, paper panel — in this kit `ink-950`/`ink-900` are the pale
          drafting-paper surfaces, so the previous pairing painted a white
          sheet behind a white drawer and the detail was unreadable. */}
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-[#101814]/55 backdrop-blur-sm" />
      <aside
        role="dialog"
        aria-modal="true"
        className="relative flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l-2 border-[#101814] bg-[#f1f3eb] p-6 shadow-[-8px_0_0_0_rgba(16,24,20,0.18)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-white">{model.name}</h2>
            <p className="mt-1 font-mono text-[11px] tracking-[0.12em] text-white/40">
              {model.provider} · {model.id}
            </p>
          </div>
          <button
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/12 bg-white/5 text-white/60 transition-colors hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <p className="mt-4 text-[13.5px] leading-relaxed text-white/60">{model.blurb}</p>

        
<div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            { k: "context window", v: model.context ? `${model.context.toLocaleString()} tok` : "n/a" },
            { k: "median ttft", v: model.ttft ? `${model.ttft} ms` : "—" },
            { k: "throughput", v: model.throughput ? `${model.throughput} tok/s` : "batch" },
            { k: "input price", v: `$${model.priceIn} / 1M` },
            { k: "output price", v: `$${model.priceOut} / 1M` },
            { k: "license", v: model.license },
          ].map((s) => (
            <div key={s.k} className="rounded-xl border border-white/8 bg-white/[0.03] p-3.5">
              <div className="font-mono text-[9.5px] tracking-[0.16em] text-white/40 uppercase">{s.k}</div>
              <div className="mt-1.5 text-[12.5px] text-white/85">{s.v}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-7 font-display text-[13px] font-semibold tracking-wide text-white uppercase">
          Best for
        </h3>
        
<ul className="mt-3 space-y-2">
          {model.strengths.length === 0 ? (
            <li className="text-[13px] text-white/45">No curated notes for this model yet.</li>
          ) : null}
          {model.strengths.map((s) => (
            <li key={s} className="flex items-center gap-3 text-[13px] text-white/65">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-brand-ember" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 12.5l5 5L20 6.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {s}
            </li>
          ))}
        </ul>

        <div className="mt-7 flex flex-wrap gap-2">
          {[...model.tags, ...model.modality].map((t) => (
            <span key={t} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-white/55 uppercase">
              {t}
            </span>
          ))}
        </div>

        <div className="mt-7">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-[13px] font-semibold tracking-wide text-white uppercase">
              Quickstart
            </h3>
            <CopyButton text={model.id} label="Copy model id" />
          </div>
          <CodeTabs modelId={model.id} />
        </div>

        
<div className="sticky bottom-0 mt-8 flex gap-2 border-t border-white/8 bg-ink-900/95 pt-4">
          <button
            onClick={() => onTry(model.id)}
            className="flex-1 rounded-full bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 px-5 py-3 text-[13px] font-medium text-white transition-all hover:shadow-[0_16px_40px_-16px_rgba(36,71,232,0.28)]"
          >
            Open in playground
          </button>
          <a
            href="#/ragestar/keys"
            className="rounded-full border border-white/12 bg-white/5 px-5 py-3 text-[13px] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
          >
            Get API key
          </a>
        </div>
      </aside>
    </div>
  );
}


export function ModelCatalog({ variant = "dashboard", onTry, models: modelsProp }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("ttft");
  const [selected, setSelected] = useState(null);

  /* The published catalog (public_models) when the gateway answers. Public page
     and dashboard share this component, so it loads its own list unless a
     caller passes one in.

     There is no fixture fallback any more. It used to paint a built-in list of
     models and then swap them for the real catalog a moment later — the
     "shows one thing, then changes" flash. While the list is still loading the
     count is 0 and the grid says so, rather than showing models that may not
     exist on this account.

     The hook comes from lib/useCatalog.js rather than lib/workspace.js: that
     one shares a single in-flight request across every component on the page,
     so the stat tiles above this list can no longer report a different number
     from the list itself. Same signature, so nothing below changes. */
  const loaded = useCatalog();
  const models = modelsProp ?? loaded ?? [];
  const pending = modelsProp ? false : loaded === null;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = models.filter((m) => {
      const matchesQuery = !q || `${m.name} ${m.provider} ${m.id} ${m.tags.join(" ")} ${m.blurb}`.toLowerCase().includes(q);
      const matchesFilter =
        filter === "all" ||
        (filter === "open" ? m.license === "Open weights" : m.modality.includes(filter));
      return matchesQuery && matchesFilter;
    });
    out = [...out].sort((a, b) => {
      if (sort === "price") return a.priceIn - b.priceIn;
      if (sort === "context") return b.context - a.context;
      /* ttft is null on live rows (the gateway does not measure it), so sort
         those to the end instead of treating null as 0 and floating them up */
      if (a.ttft == null && b.ttft == null) return a.name.localeCompare(b.name);
      if (a.ttft == null) return 1;
      if (b.ttft == null) return -1;
      return a.ttft - b.ttft;
    });
    return out;
  }, [query, filter, sort, models]);

  const handleTry = (id) => {
    setSelected(null);
    onTry?.(id);
  };

  
const grid = (
    <div className={cn("grid gap-4", variant === "public" ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4")}>
      {list.map((m) => (
        <ModelCard key={m.id} model={m} onSelect={() => setSelected(m)} onTry={() => handleTry(m.id)} />
      ))}
      {list.length === 0 && !pending ? (
        <p className="col-span-full py-8 text-center text-[13px] text-white/45">
          No models match that search.
        </p>
      ) : null}
    </div>
  );

  
const controls = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1">
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-white/35"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.5-4.5" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${models.length} models, capabilities, providers…`}
          className="w-full rounded-full border border-white/10 bg-white/[0.05] py-2.5 pr-3 pl-9 text-[12.5px] text-white placeholder:text-white/35 focus:border-brand-ember/60 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] p-1">
        {["ttft", "price", "context"].map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={cn(
              "rounded-full px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] uppercase transition-colors",
              sort === s ? "bg-white/90 text-ink-950" : "text-white/50 hover:text-white",
            )}
          >
            {s === "ttft" ? "fastest" : s}
          </button>
        ))}
      </div>
    </div>
  );

  
return (
    <div>
      <div className="flex flex-wrap gap-2">
        {modelFilters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 font-mono text-[10.5px] tracking-[0.12em] uppercase transition-all duration-300",
              filter === f.id
                ? "border-brand-ember/45 bg-brand-ember/12 text-orange-100"
                : "border-white/10 bg-white/[0.035] text-white/50 hover:text-white",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-5">{controls}</div>

      <p className="mt-4 font-mono text-[10.5px] tracking-[0.14em] text-white/35 uppercase">
        {list.length} of {models.length} models · {sort === "ttft" ? "sorted by latency" : `sorted by ${sort}`}
      </p>

      <div className="mt-4">{grid}</div>

      {pending ? (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] py-16 text-center">
          <p className="text-[13.5px] text-white/50">Loading the model catalog…</p>
          <p className="mt-1.5 text-[12px] text-white/35">
            Only the models this workspace can actually route to are listed.
          </p>
        </div>
      ) : null}

      
{list.length === 0 && !pending && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.02] py-16 text-center">
          <p className="text-[13.5px] text-white/50">
            {query || filter !== "all" ? (
              <>
                No models match “{query}”. <button onClick={() => { setQuery(""); setFilter("all"); }} className="text-brand-ember underline">Reset filters</button>
              </>
            ) : (
              "No models are published for this workspace yet."
            )}
          </p>
        </div>
      )}

      {selected && (
        <ModelDetail model={selected} onClose={() => setSelected(null)} onTry={handleTry} />
      )}
    </div>
  );
}
