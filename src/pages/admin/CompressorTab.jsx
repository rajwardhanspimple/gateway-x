import React, { useEffect, useMemo, useState } from "react";
import { Alert, Button } from "../../components/ui";
import {
  COMPRESSOR_UPGRADE_FILE,
  deleteCompressor,
  getCompressionEnabled,
  listCompressors,
  saveCompressor,
  setCompressionEnabled,
  setCompressorActive,
} from "../../lib/db";
import {
  EMPTY_COMPRESSOR,
  MODES,
  PRESETS,
  SCOPES,
  STAGES,
  compressMessages,
  compressPipeline,
  compressText,
  estimateTokens,
  slugify,
} from "../../lib/compress";

/* ============================================================================
   Token compressors
   ----------------------------------------------------------------------------
   A gateway is billed by the token, so the cheapest saving available is to
   stop forwarding tokens nobody meant to send. This tab owns that: as many
   named compressors as the workspace wants, each one a small ordered pipeline
   of stages, all of them stacked in priority order on the way to the upstream.

   Every number on this screen is measured, not promised — the table runs each
   compressor over the sample at the bottom using the same engine the edge
   function runs at the border (src/lib/compress.js and its Deno twin
   supabase/functions/_shared/compress.ts), so what you preview is what your
   customers' prompts will actually become.

   Ordering is by `priority` ascending, which reads oddly at first but matches
   the rest of the panel (upstreams, routes): the small number goes first.
============================================================================ */

/* A stage compressor can be judged on one paragraph. A ponytail cannot: it
   only does anything once there is a history to tie back, so the bench keeps a
   real conversation around and appends whatever is in the box as the newest
   turn. Short enough to read, long enough to fold. */
const SAMPLE_CHAT = [
  { role: "system", content: "You are the support assistant for RageStar. Be brief and never invent prices." },
  { role: "user", content: "Hi! I signed up yesterday with the email ada@lovelace.dev and I cannot see my credits." },
  { role: "assistant", content: "Thanks for reaching out! Let me take a look at that account for you right away." },
  { role: "user", content: "Basically, I paid $12.50 through the checkout page and the receipt id was RS-40128." },
  { role: "assistant", content: "I can see the payment of $12.50 against receipt RS-40128. It settled but was not applied to your balance." },
  { role: "user", content: "Ok so, um, what I actually need is for the credits to show up before my demo tomorrow at 09:00 IST." },
  { role: "assistant", content: "Understood. I have applied the 12.50 manually, so your balance should be correct within a minute or two." },
  { role: "user", content: "Thanks. While you are in there, could you also tell me which model my key gpt-4o-mini maps to?" },
  { role: "assistant", content: "Your public id gpt-4o-mini routes to our fast tier. The mapping is set per workspace in the admin panel." },
  { role: "user", content: "And the rate limit? I am going to be hammering it during the demo, roughly 40 requests a minute." },
  { role: "assistant", content: "Your plan allows 60 requests per minute per key, so 40 is comfortably inside the limit." },
  { role: "user", content: "Perfect. One last thing: I would really like the invoice addressed to Lovelace Analytics Ltd, VAT GB123456789." },
  { role: "assistant", content: "Noted — I have set the billing name to Lovelace Analytics Ltd with VAT GB123456789 on the account." },
];

function chatWith(sample) {
  return [...SAMPLE_CHAT, { role: "user", content: String(sample || "") }];
}

/* One measurement for both kinds of compressor. Ponytail results are mapped
   onto the same shape a stage run returns, so every table and every row in
   this tab keeps reading `ratio`, `saved`, `skipped` and `trace` without
   caring which engine produced them. */
function measure(row, sample) {
  if ((row?.mode || "stages") !== "ponytail") return compressText(sample, row);

  const chat = chatWith(sample);
  const res = compressMessages(chat, row);
  return {
    text: res.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
    before: res.before,
    after: res.after,
    saved: res.saved,
    ratio: res.ratio,
    skipped: res.skipped,
    trace: res.skipped
      ? []
      : [
          {
            id: "ponytail",
            label: `${chat.length} turns \u2192 ${res.messages.length} forwarded`,
            saved: res.saved,
            lossy: true,
          },
        ],
  };
}

const SAMPLE = `You are a helpful assistant.

## Instructions

Please note that I would like you to carefully review the configuration
documentation provided below and, basically, just summarise the key
requirements for the application in question.

It is important to note that   the   deployment   must be idempotent.
It is important to note that   the   deployment   must be idempotent.

\`\`\`json
{
  "retries":     3,
  "timeout_ms":  60000,
  "regions":     ["iad", "fra"]
}
\`\`\`

<div class="note">In order to proceed, at this point in time, please confirm.</div>

- **Logging** is required for each and every request
- **Failover** should be attempted with the next available key`;

function asPct(ratio) {
  return `${Math.round((Number(ratio) || 0) * 100)}%`;
}

function scopeLabel(id) {
  return SCOPES.find((s) => s.id === id)?.label || id;
}

function parseModelIds(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A stage chip in the editor. Order is the click order, and it is shown,
 *  because "strip HTML then minify JSON" and the reverse do not cost the
 *  same number of tokens. */
function StageChip({ stage, index, onToggle }) {
  const on = index >= 0;
  return (
    <label className={`cmp-stage${on ? " is-on" : ""}`} title={stage.note}>
      <input type="checkbox" checked={on} onChange={() => onToggle(stage.id)} />
      <span className="cmp-stage-order">{on ? index + 1 : "\u2013"}</span>
      <span className="cmp-stage-body">
        <b>{stage.label}</b>
        <i>{stage.note}</i>
      </span>
      {stage.lossy ? <span className="badge badge-warn">lossy</span> : null}
    </label>
  );
}

export default function CompressorTab() {
  const [rows, setRows] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [localOnly, setLocalOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [sample, setSample] = useState(SAMPLE);
  const [traceOf, setTraceOf] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [list, on] = await Promise.all([listCompressors(), getCompressionEnabled()]);
      setRows(Array.isArray(list) ? list : []);
      setEnabled(on !== false);
      setLocalOnly((Array.isArray(list) ? list : []).some((r) => r._local));
    } catch (e) {
      setMsg({ tone: "error", text: e.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  /* ---------------------------------------------------------- measurements */

  const perRow = useMemo(() => {
    const out = {};
    for (const r of rows) out[r.id] = measure(r, sample);
    return out;
  }, [rows, sample]);

  const stack = useMemo(() => {
    const active = enabled ? rows : [];
    /* Handing a ponytail a two-message payload would always read "no change",
       which is true and useless. When one is in the stack the bench forwards
       the whole sample conversation instead. */
    const wholeChat = active.some(
      (r) => r.is_active !== false && (r.mode || "stages") === "ponytail",
    );
    const payload = wholeChat
      ? chatWith(sample)
      : [
          { role: "system", content: "You are the support assistant for RageStar." },
          { role: "user", content: sample },
        ];
    return compressPipeline(payload, active);
  }, [rows, sample, enabled]);

  const preview = useMemo(() => (draft ? measure(draft, sample) : null), [draft, sample]);

  const activeCount = rows.filter((r) => r.is_active !== false).length;
  const takenSlugs = useMemo(() => new Set(rows.map((r) => r.slug)), [rows]);

  /* --------------------------------------------------------------- actions */

  function uniqueSlug(base) {
    const root = slugify(base) || "compressor";
    if (!takenSlugs.has(root)) return root;
    let n = 2;
    while (takenSlugs.has(`${root}-${n}`)) n += 1;
    return `${root}-${n}`;
  }

  function nextPriority() {
    return rows.length ? Math.max(...rows.map((r) => Number(r.priority) || 0)) + 10 : 10;
  }

  async function run(key, fn, okText) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ tone: "ok", text: okText });
      await load();
    } catch (e) {
      setMsg({ tone: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  function addPreset(preset) {
    run(
      `preset:${preset.slug}`,
      () => saveCompressor({ ...preset, slug: uniqueSlug(preset.slug), priority: nextPriority() }),
      `${preset.name} added.`,
    );
  }

  function save() {
    if (!draft) return;
    if (!draft.name?.trim()) {
      setMsg({ tone: "error", text: "Give the compressor a name so the logs are readable." });
      return;
    }
    if (!draft.stages?.length) {
      setMsg({ tone: "error", text: "A compressor with no stages would forward the prompt unchanged." });
      return;
    }
    const payload = { ...draft, slug: draft.slug?.trim() ? slugify(draft.slug) : uniqueSlug(draft.name) };
    run("save", async () => {
      await saveCompressor(payload);
      setDraft(null);
    }, `${payload.name} saved.`);
  }

  function toggleStage(id) {
    setDraft((d) => {
      if (!d) return d;
      const stages = d.stages || [];
      return { ...d, stages: stages.includes(id) ? stages.filter((s) => s !== id) : [...stages, id] };
    });
  }

  const field = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  /* ---------------------------------------------------------------- render */

  return (
    <div className="adm-card">
      <div className="adm-head">
        <div>
          <h2>Token compressors</h2>
          <p className="muted small">
            Rewrite prompts before they leave your gateway. Stages run in the order you pick them,
            compressors run in priority order, and code fences are held back unless you say otherwise.
          </p>
        </div>
        <div className="adm-head-actions">
          <Button
            size="sm"
            variant={enabled ? "primary" : "ghost"}
            loading={busy === "master"}
            onClick={() =>
              run("master", async () => {
                await setCompressionEnabled(!enabled);
              }, !enabled ? "Compression is on." : "Compression is off — prompts forward untouched.")
            }
          >
            {enabled ? "Compression on" : "Compression off"}
          </Button>
          <Button size="sm" variant="ghost" loading={loading} onClick={load}>
            Reload
          </Button>
          <Button
            size="sm"
            onClick={() => setDraft({ ...EMPTY_COMPRESSOR, priority: nextPriority(), model_ids: [] })}
          >
            New compressor
          </Button>
        </div>
      </div>

      {msg ? (
        <Alert tone={msg.tone} action={<button type="button" onClick={() => setMsg(null)}>Dismiss</button>}>
          {msg.text}
        </Alert>
      ) : null}

      {localOnly ? (
        <Alert tone="info" title="These compressors live in this browser">
          The <code>token_compressors</code> table is not installed yet, so the designs below are kept in
          local storage and the router is still forwarding prompts unchanged. Run{" "}
          <code>supabase/{COMPRESSOR_UPGRADE_FILE}</code> in the Supabase SQL editor, then reload — the
          same compressors will save to Postgres and take effect at the border.
        </Alert>
      ) : null}

      {!enabled ? (
        <Alert tone="info" title="Compression is switched off">
          Individual compressors keep their own on/off state, but nothing is applied while the master
          switch is off. The table still measures them so you can compare before committing.
        </Alert>
      ) : null}

      <div className="adm-stats">
        <div className="adm-stat">
          <span className="adm-label">Compressors</span>
          <b>{rows.length}</b>
          <i>{activeCount} enabled</i>
        </div>
        <div className="adm-stat">
          <span className="adm-label">Sample prompt</span>
          <b>{stack.before}</b>
          <i>tokens in</i>
        </div>
        <div className="adm-stat">
          <span className="adm-label">Forwarded</span>
          <b>{stack.after}</b>
          <i>tokens out</i>
        </div>
        <div className="adm-stat">
          <span className="adm-label">Saved on the stack</span>
          <b>{asPct(stack.ratio)}</b>
          <i>{stack.saved} tokens</i>
        </div>
      </div>

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>Prio</th>
              <th>Compressor</th>
              <th>Scope</th>
              <th>Stages</th>
              <th>Floor</th>
              <th>On this sample</th>
              <th>State</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const res = perRow[r.id] || { saved: 0, ratio: 0, trace: [] };
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td className="mono">{r.priority}</td>
                    <td>
                      <b>{r.name}</b>
                      <div className="faint xs mono">{r.slug}</div>
                      {r.model_ids?.length ? (
                        <div className="faint xs">only {r.model_ids.join(", ")}</div>
                      ) : null}
                    </td>
                    <td className="xs">{scopeLabel(r.scope)}</td>
                    <td className="xs">
                      {(r.mode || "stages") === "ponytail" ? (
                        <span title="Whole-conversation compressor">
                          ponytail · keeps {r.head_messages ?? 4}
                        </span>
                      ) : (
                        (r.stages || []).join(" → ")
                      )}
                    </td>
                    <td className="mono xs">{r.min_tokens ? `${r.min_tokens} tok` : "\u2014"}</td>
                    <td>
                      {res.skipped ? (
                        <span className="faint xs">skipped: {res.skipped}</span>
                      ) : (
                        <b className="mono">
                          &minus;{asPct(res.ratio)}{" "}
                          <span className="faint xs">({res.saved} tok)</span>
                        </b>
                      )}
                    </td>
                    <td>
                      <span className={`st ${r.is_active !== false ? "st-ok" : "st-off"}`}>
                        {r.is_active !== false ? "enabled" : "off"}
                      </span>
                    </td>
                    <td className="adm-row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTraceOf(traceOf === r.id ? "" : r.id)}
                      >
                        {traceOf === r.id ? "Hide" : "Trace"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDraft({ ...r })}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setDraft({
                            ...r,
                            id: undefined,
                            name: `${r.name} copy`,
                            slug: uniqueSlug(`${r.slug}-copy`),
                            priority: nextPriority(),
                          })
                        }
                      >
                        Duplicate
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `active:${r.id}`}
                        onClick={() =>
                          run(`active:${r.id}`, () => setCompressorActive(r.id, r.is_active === false))
                        }
                      >
                        {r.is_active !== false ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `del:${r.id}`}
                        onClick={() => {
                          if (!window.confirm(`Delete ${r.name}? Prompts will stop being rewritten by it.`)) return;
                          run(`del:${r.id}`, () => deleteCompressor(r.id), `${r.name} deleted.`);
                        }}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                  {traceOf === r.id ? (
                    <tr>
                      <td colSpan={8}>
                        <div className="fl-rows">
                          {(res.trace || []).length ? (
                            res.trace.map((t) => (
                              <div className="fl-row" key={t.id}>
                                <span>
                                  {t.label}
                                  {t.lossy ? " \u00b7 lossy" : ""}
                                  {t.failed ? " \u00b7 failed" : ""}
                                </span>
                                <span>{t.saved ? `\u2212${t.saved} tok` : "no change"}</span>
                              </div>
                            ))
                          ) : (
                            <div className="fl-row">
                              <span>Nothing ran</span>
                              <span>{res.skipped || "no stages"}</span>
                            </div>
                          )}
                        </div>
                        {r.description ? <p className="muted small">{r.description}</p> : null}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
            {!rows.length && !loading ? (
              <tr>
                <td colSpan={8}>
                  <div className="adm-empty">
                    No compressors yet. Add one of the presets below, or build your own.
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="adm-presets">
        <span className="adm-label">Add a preset</span>
        <div className="adm-preset-row">
          {PRESETS.map((p) => (
            <Button
              key={p.slug}
              size="sm"
              variant="ghost"
              loading={busy === `preset:${p.slug}`}
              onClick={() => addPreset(p)}
              title={p.description}
            >
              {takenSlugs.has(p.slug) ? `${p.name} (again)` : p.name}
            </Button>
          ))}
        </div>
      </div>

      {draft ? (
        <div className="adm-card is-nested">
          <div className="adm-head">
            <div>
              <h3>{draft.id ? `Edit ${draft.name || "compressor"}` : "New compressor"}</h3>
              <p className="muted small">
                The preview underneath is this compressor run over the bench sample, stage by stage.
              </p>
            </div>
          </div>

          <div className="adm-grid">
            <label>
              <span className="adm-label">Name</span>
              <input className="adm-input" value={draft.name || ""} onChange={field("name")} placeholder="Prompt diet" />
            </label>
            <label>
              <span className="adm-label">Slug</span>
              <input
                className="adm-input mono"
                value={draft.slug || ""}
                onChange={field("slug")}
                placeholder="prompt-diet"
              />
            </label>
            <label>
              <span className="adm-label">Mode</span>
              <select className="adm-select" value={draft.mode || "stages"} onChange={field("mode")}>
                {MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <i className="faint xs">
                {MODES.find((m) => m.id === (draft.mode || "stages"))?.note}
              </i>
            </label>
            <label>
              <span className="adm-label">Applies to</span>
              <select className="adm-select" value={draft.scope || "all"} onChange={field("scope")}>
                {SCOPES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="adm-label">Priority</span>
              <input
                className="adm-input mono"
                type="number"
                value={draft.priority ?? 100}
                onChange={field("priority")}
              />
            </label>
            <label>
              <span className="adm-label">Token floor</span>
              <input
                className="adm-input mono"
                type="number"
                value={draft.min_tokens ?? 0}
                onChange={field("min_tokens")}
              />
              <i className="faint xs">Shorter prompts are left alone.</i>
            </label>
            <label>
              <span className="adm-label">Character budget</span>
              <input
                className="adm-input mono"
                type="number"
                value={draft.max_chars ?? 6000}
                onChange={field("max_chars")}
              />
              <i className="faint xs">Used by the middle-out stage.</i>
            </label>
            <label className="adm-grid-wide">
              <span className="adm-label">Only these model ids</span>
              <input
                className="adm-input mono"
                value={(draft.model_ids || []).join(", ")}
                onChange={(e) => setDraft((d) => ({ ...d, model_ids: parseModelIds(e.target.value) }))}
                placeholder="blank = every model"
              />
            </label>
            <label className="adm-grid-wide">
              <span className="adm-label">Note for the team</span>
              <input
                className="adm-input"
                value={draft.description || ""}
                onChange={field("description")}
                placeholder="What this one is for, and what it costs you."
              />
            </label>
          </div>

          <div className="cmp-stages">
            <span className="adm-label">Stages, in order</span>
            <div className="cmp-stage-grid">
              {STAGES.map((s) => (
                <StageChip
                  key={s.id}
                  stage={s}
                  index={(draft.stages || []).indexOf(s.id)}
                  onToggle={toggleStage}
                />
              ))}
            </div>
          </div>

          <label className="cmp-check">
            <input
              type="checkbox"
              checked={draft.preserve_code !== false}
              onChange={(e) => setDraft((d) => ({ ...d, preserve_code: e.target.checked }))}
            />
            <span>
              Hold back fenced code blocks — they are lifted out before the stages run and put back
              afterwards, so indentation and syntax survive.
            </span>
          </label>

          {(draft.mode || "stages") === "ponytail" ? (
            <div className="cmp-stages">
              <span className="adm-label">Ponytail</span>
              <p className="faint xs">
                The newest turns and the system prompt are forwarded word for word. Older turns are
                thinned by the stages above and then tied into a single digest message.
              </p>
              <div className="adm-grid">
                <label>
                  <span className="adm-label">Turns kept whole</span>
                  <input
                    className="adm-input mono"
                    type="number"
                    min={0}
                    value={draft.head_messages ?? 4}
                    onChange={field("head_messages")}
                  />
                  <i className="faint xs">Counted from the end of the conversation.</i>
                </label>
                <label>
                  <span className="adm-label">Budget per older turn</span>
                  <input
                    className="adm-input mono"
                    type="number"
                    min={120}
                    value={draft.tail_chars ?? 700}
                    onChange={field("tail_chars")}
                  />
                  <i className="faint xs">Characters kept before a turn is reduced to its spine.</i>
                </label>
              </div>

              <label className="cmp-check">
                <input
                  type="checkbox"
                  checked={draft.keep_system !== false}
                  onChange={(e) => setDraft((d) => ({ ...d, keep_system: e.target.checked }))}
                />
                <span>Never touch system messages — they are instructions, not history.</span>
              </label>

              <label className="cmp-check">
                <input
                  type="checkbox"
                  checked={draft.tail_digest !== false}
                  onChange={(e) => setDraft((d) => ({ ...d, tail_digest: e.target.checked }))}
                />
                <span>
                  Fold the older turns into one digest message. Off keeps them as separate, shorter
                  messages, which some providers prefer.
                </span>
              </label>

              <label className="cmp-check">
                <input
                  type="checkbox"
                  checked={draft.keep_entities !== false}
                  onChange={(e) => setDraft((d) => ({ ...d, keep_entities: e.target.checked }))}
                />
                <span>
                  Hold back names, numbers, prices, ids, emails and urls before thinning, so the
                  facts of the conversation survive the summary.
                </span>
              </label>

              {draft._ponytail_ready === false ? (
                <p className="faint xs">
                  This database has not run the v11 upgrade yet, so these settings cannot be saved.
                  Run supabase/upgrade-v11.0-keywatch-and-ponytail.sql first.
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="cmp-check">
            <input
              type="checkbox"
              checked={draft.is_active !== false}
              onChange={(e) => setDraft((d) => ({ ...d, is_active: e.target.checked }))}
            />
            <span>Enabled — include this compressor in the stack.</span>
          </label>

          {preview ? (
            <div className="fl-rows">
              <div className="fl-row">
                <span>Result on the sample</span>
                <span>
                  {preview.before} &rarr; {preview.after} tokens ({asPct(preview.ratio)} off)
                </span>
              </div>
              {(preview.trace || []).map((t) => (
                <div className="fl-row" key={t.id}>
                  <span>
                    {t.label}
                    {t.lossy ? " \u00b7 lossy" : ""}
                  </span>
                  <span>{t.saved ? `\u2212${t.saved} tok` : "no change"}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="adm-form-actions">
            <Button loading={busy === "save"} onClick={save}>
              {draft.id ? "Save changes" : "Create compressor"}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="adm-card is-nested">
        <div className="adm-head">
          <div>
            <h3>Bench</h3>
            <p className="muted small">
              Paste a real prompt. Everything above re-measures as you type, and this is the payload your
              upstream would actually receive.
            </p>
          </div>
          <div className="adm-head-actions">
            <Button size="sm" variant="ghost" onClick={() => setSample(SAMPLE)}>
              Reset sample
            </Button>
          </div>
        </div>

        <textarea
          className="adm-input cmp-sample"
          rows={10}
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          spellCheck={false}
        />
        <p className="faint xs mono">{estimateTokens(sample)} tokens in the sample</p>

        <div className="fl-rows">
          {(stack.steps || []).map((s) => (
            <div className="fl-row" key={s.slug}>
              <span>{s.name}</span>
              <span>
                {s.saved ? `\u2212${s.saved} tok` : "no change"} &middot; {s.after} left
              </span>
            </div>
          ))}
          {!(stack.steps || []).length ? (
            <div className="fl-row">
              <span>Nothing in the stack</span>
              <span>the prompt forwards unchanged</span>
            </div>
          ) : null}
        </div>

        <div className="fl-code">
          <div className="fl-code-top">
            <span>forwarded messages</span>
            <span className="mono xs">
              {stack.before} &rarr; {stack.after} tokens
            </span>
          </div>
          <pre>{stack.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n")}</pre>
        </div>
      </div>
    </div>
  );
}
