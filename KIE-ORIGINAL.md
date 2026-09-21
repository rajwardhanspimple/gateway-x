# KIE ORIGINAL

One key, pasted once in **Admin -> KIE ORIGINAL**, and everything else follows.
There is no Anthropic provider and no second upstream: KIE is the only upstream,
and the gateway translates every harness dialect at its own edge.

## What a pasted key does

1. It is mirrored into a hidden routable upstream named `KIE ORIGINAL`
   (`https://api.kie.ai` + `/codex/v1/responses`, the only shape KIE accepts).
2. Its models are published into **Model mapping**: `kie-original` for the
   default model, `kie-<model>` for the rest.
3. `kie-original` is the **catch-all** and carries aliases, so a harness asking
   for `claude-sonnet-4-5`, `gpt-5-codex` or anything unknown is still served.
4. Key health flows both ways: the router marks the key, the panel shows it.

## Harnesses

| Harness | Endpoint | Setup |
| --- | --- | --- |
| Claude Code | `POST /v1/messages` | `ANTHROPIC_BASE_URL=https://gw.ragestar.bond/v1`, `ANTHROPIC_AUTH_TOKEN=<rs_ key>`, `ANTHROPIC_MODEL=kie-original` |
| Codex CLI | `POST /v1/responses` | `model = "kie-original"`, `model_provider = "ragestar"`, `wire_api = "responses"` |
| Cursor, Cline, Roo, Aider, Open WebUI, SDKs | `POST /v1/chat/completions` | base url `https://gw.ragestar.bond/v1`, model `kie-original` |
| Legacy completions | `POST /v1/completions` | same key |

The key may arrive as `Authorization: Bearer`, `x-api-key` or
`anthropic-api-key` - all three are accepted. Every reply carries
`x-rs-dialect` and `x-rs-harness` so you can see how it was read.

## Usage

Both **Console -> Usage** and **Admin -> KIE ORIGINAL** show a spreadsheet:
column letters, row numbers, a formula bar, click-to-sort, a filter box, a
totals row, arrow-key selection, `cmd+C` for a cell, `shift+cmd+C` for a row,
and CSV export. Columns include dialect, harness, tokens in/out, latency and
cost per request.

## Deploy

```bash
npm run kie:up      # apply supabase/upgrade-v11.6-kie-original.sql, then deploy
```
