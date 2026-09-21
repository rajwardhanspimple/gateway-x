# KIE ORIGINAL codex `/responses` - the only supported shape

This is the contract the gateway now speaks.

> The provider is called **KIE ORIGINAL**. For how a pasted key reaches
> model mapping and every harness, see `KIE-ORIGINAL.md`. It is a transcription of the
working reference client (`scripts/kie-probe.py`) plus a full map of the output
so nothing Kie sends is silently dropped.

---

## 1. The request (this and nothing else)

```http
POST /codex/v1/responses HTTP/1.1
Host: api.kie.ai
Authorization: Bearer <KIE_API_KEY>
Content-Type: application/json
```

```json
{
  "model": "gpt-6-astra",
  "stream": true,
  "input": "Say hello in one word.",
  "tools": [{ "type": "web_search" }],
  "reasoning": { "effort": "high" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `model` | yes | `gpt-6-astra` is the default in the DB seed. |
| `stream` | yes | Always `true`. Kie answers `text/event-stream`. |
| `input` | yes | Either a plain string (Test A) **or** the parts array (Test B). |
| `tools` | no | Only `[{ "type": "web_search" }]` is used. |
| `reasoning` | no | `{ "effort": "low" \| "medium" \| "high" }`. |

`input` in parts form:

```json
"input": [
  {
    "role": "user",
    "content": [
      { "type": "input_text",  "text": "What is in this image?" },
      { "type": "input_image", "image_url": "https://file.aiquickdraw.com/…png" }
    ]
  }
]
```

**Never sent any more** (all of it is rejected by the edge function before the
call leaves the gateway):

- `messages[]` + `max_tokens` — the Anthropic / chat-completions shape
- `temperature`, `top_p`, `max_output_tokens` and other sampling knobs
- `stream: false`
- any third header (no `Accept: text/event-stream`, no `anthropic-version`, no
  provider `extra_headers`) — Kie sees exactly `Authorization` and
  `Content-Type`
- any endpoint other than `https://api.kie.ai/codex/v1/responses`

---

## 2. The response envelope

| | |
| --- | --- |
| Status | `200` on success |
| `Content-Type` | `text/event-stream` (a JSON body is handled defensively, never requested) |
| Framing | SSE: lines starting with `data:`; anything else (`event:`, `id:`, blank keep-alives) is ignored |
| Terminator | the literal line `data: [DONE]` — stop reading there |
| Payload | one JSON object per `data:` line, each with a `type` |

The only two lines the reference client acts on are
`response.output_text.delta` (the answer, character-by-character in `delta`) and
`response.completed` (`response.usage`, `response.credits_consumed`). Everything
else below is still emitted and is now captured by the gateway.

---

## 3. Every event, and what it carries

### Lifecycle

| Event | Payload of interest |
| --- | --- |
| `response.created` | `response.id`, `response.model`, `response.status: "in_progress"`, echoed `tools` / `reasoning` |
| `response.in_progress` | same object, work started |
| `response.completed` | **`response.usage`**, **`response.credits_consumed`**, `response.status: "completed"`, full `response.output[]` |
| `response.incomplete` | `response.incomplete_details.reason` (e.g. token cap hit) |
| `response.failed` | `response.error.{type,code,message}` |
| `error` / `response.error` | mid-stream failure; `error.{type,code,message}` |

### Items and parts (the structure around the text)

| Event | Payload of interest |
| --- | --- |
| `response.output_item.added` | `output_index`, `item.{id,type,status}`; `item.type` is `message`, `reasoning`, or `web_search_call` |
| `response.output_item.done` | the finished item, including a `reasoning` item's `summary[]` |
| `response.content_part.added` | `item_id`, `content_index`, `part.type` (`output_text` / `refusal`) |
| `response.content_part.done` | the finished part with its accumulated `text` |

### Text

| Event | Payload of interest |
| --- | --- |
| `response.output_text.delta` | **`delta`** — append in arrival order; this is the answer |
| `response.output_text.done` | `text` — the whole message, useful as a checksum against your concatenation |
| `response.output_text.annotation.added` | `annotation` — web_search citations (`url`, `title`, `start_index`, `end_index`) |
| `response.refusal.delta` / `.done` | `delta` / `refusal` when the model declines |

### Reasoning (only with `reasoning.effort`)

| Event | Payload of interest |
| --- | --- |
| `response.reasoning_summary_part.added` / `.done` | summary part scaffolding |
| `response.reasoning_summary_text.delta` / `.done` | `delta` / `text` — the visible thinking summary |
| `response.reasoning_text.delta` / `.done` | raw reasoning text when the deployment exposes it |

Raw chain-of-thought is not guaranteed; treat the summary as the only reasoning
you will reliably get.

### `web_search` tool

| Event | Payload of interest |
| --- | --- |
| `response.web_search_call.in_progress` | `item_id`, `output_index` |
| `response.web_search_call.searching` | the query is running |
| `response.web_search_call.completed` | search finished; results feed the next text deltas |
| `response.output_item.done` (`item.type: "web_search_call"`) | `item.status`, `item.action` / `item.query` when present |

Citations for those searches arrive as `…annotation.added`, not inside the tool
events.

### Accounting

`response.completed` → `response.usage` uses Responses-API naming:

```json
"usage": {
  "input_tokens": 12,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens": 5,
  "output_tokens_details": { "reasoning_tokens": 0 },
  "total_tokens": 17
}
```

`response.credits_consumed` is Kie's own billing number — it is **not** an
OpenAI field, so read it from Kie's event, never compute it from tokens.

### Non-stream fallback (parsed, never requested)

```json
{
  "id": "resp_…",
  "model": "gpt-6-astra",
  "status": "completed",
  "output": [
    { "type": "reasoning", "summary": [] },
    { "type": "message", "role": "assistant",
      "content": [{ "type": "output_text", "text": "Hello", "annotations": [] }] }
  ],
  "usage": { "…": "…" },
  "credits_consumed": 1
}
```

The text lives at `output[].content[]` where `content.type === "output_text"` —
exactly what the reference client reads.

### Failures

| Status | What comes back |
| --- | --- |
| `401` / `403` | JSON error body, no stream — bad or disabled key |
| `400` | JSON error body — usually a field Kie does not accept (this is what `messages` / `max_tokens` produced) |
| `402` / `429` | out of credits or rate limited |
| `5xx` | JSON or HTML error body |
| `200` then `response.failed` | the call started and then broke; read `response.error` |

On a non-200 the body is **not** SSE, so read it whole — the reference client
prints it verbatim, and the gateway stores the first 500 chars on the key row.

---

## 4. Reading order (what a correct client does)

1. Split the stream on newlines; keep only lines starting with `data:`.
2. Stop at `[DONE]`.
3. `json.loads` the rest and switch on `type`.
4. Concatenate `response.output_text.delta.delta` in arrival order — never
   reorder, never rely on `output_index` for text assembly.
5. Take `usage` / `credits_consumed` from `response.completed`.
6. Treat any unknown `type` as informational, never fatal; new event types are
   added over time.

---

## 5. Where this lives in the project

| File | Role |
| --- | --- |
| `supabase/functions/kie/index.ts` | builds only the shape above; pins host/path; parses every event listed here |
| `src/lib/db.js` → `testKie()`, `probeKie()` | admin-side callers; pass `model`, `prompt`/`input`, `image_url`, `web_search`, `reasoning_effort` |
| `src/pages/admin/KieTab.jsx` | shows the exact request JSON before sending, then the full analysis of the response |
| `supabase/upgrade-v11.5-kie-codex-responses.sql` | pins endpoint/stream/delta type in the DB, retires the Anthropic category |
| `scripts/kie-probe.py` | the reference client; `--dump` prints every raw event and a type tally |

Verify against the live API with:

```bash
KIE_API_KEY=… python3 scripts/kie-probe.py --dump
```

The event catalogue above is what the gateway maps. Anything the probe prints
under `unmapped events` in the admin panel is new and worth adding here.
