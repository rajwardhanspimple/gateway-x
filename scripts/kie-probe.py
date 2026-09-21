#!/usr/bin/env python3
"""
kie-probe.py — the reference Kie codex client, kept verbatim in the repo.

This is the ONE request shape Kie accepts, and the shape the gateway now sends:

    POST https://api.kie.ai/codex/v1/responses
    Authorization: Bearer <KIE_API_KEY>
    Content-Type: application/json
    { "model": "...", "stream": true, "input": ..., "tools": [...], "reasoning": {...} }

Usage:
    KIE_API_KEY=xxxx python3 scripts/kie-probe.py            # tests A + B
    KIE_API_KEY=xxxx python3 scripts/kie-probe.py --dump      # + every raw SSE event
    KIE_API_KEY=xxxx KIE_MODEL=gpt-6-astra python3 scripts/kie-probe.py

--dump prints an event-type tally, which is what you want when you are mapping
the full output contract (see KIE-CODEX-FORMAT.md).
"""

import http.client
import json
import os
import sys
import time
from collections import Counter

API_KEY = os.environ.get("KIE_API_KEY", "ebd60020ad1fdfe1cf6ae7886b129d2d")
MODEL = os.environ.get("KIE_MODEL", "gpt-6-astra")
HOST = os.environ.get("KIE_HOST", "api.kie.ai")
PATH = os.environ.get("KIE_PATH", "/codex/v1/responses")
DUMP = "--dump" in sys.argv

H = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

DOC_IMAGE = (
    "https://file.aiquickdraw.com/custom-page/akr/section-images/"
    "1759055072437dqlsclj2.png"
)


def call(payload):
    started = time.time()
    conn = http.client.HTTPSConnection(HOST, timeout=600)
    conn.request("POST", PATH, json.dumps(payload), H)
    res = conn.getresponse()
    print("Status:", res.status, "| CT:", res.getheader("content-type"))
    if res.status != 200:
        print(res.read().decode("utf-8", "replace"))
        conn.close()
        return

    if "event-stream" in (res.getheader("content-type") or ""):
        tally = Counter()
        first_delta = None
        for raw in res:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            d = line[5:].strip()
            if d == "[DONE]":
                tally["[DONE]"] += 1
                break
            ev = json.loads(d)
            tally[ev.get("type", "(untyped)")] += 1
            if DUMP:
                print("\n<<", json.dumps(ev)[:1200])
            if ev.get("type") == "response.output_text.delta":
                if first_delta is None:
                    first_delta = time.time() - started
                print(ev["delta"], end="", flush=True)
            elif ev.get("type") == "response.completed":
                print(
                    "\n[usage]",
                    ev["response"].get("usage"),
                    "| credits:",
                    ev["response"].get("credits_consumed"),
                )
        print(
            "\n[timing] total %.2fs | first delta %s"
            % (time.time() - started, "n/a" if first_delta is None else "%.2fs" % first_delta)
        )
        print("[events]")
        for name, count in tally.most_common():
            print("  %4d  %s" % (count, name))
    else:
        body = json.loads(res.read())
        for it in body.get("output", []):
            for c in it.get("content", []) or []:
                if c.get("type") == "output_text":
                    print(c["text"])
        print("[usage]", body.get("usage"), "| credits:", body.get("credits_consumed"))
        if DUMP:
            print("[raw]", json.dumps(body)[:4000])
    conn.close()


# Test A: minimal, streaming, text only
print("=== A: minimal stream ===")
call({"model": MODEL, "stream": True, "input": "Say hello in one word."})

# Test B: full doc example, streaming
print("\n=== B: doc example stream ===")
call(
    {
        "model": MODEL,
        "stream": True,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "What is in this image?"},
                    {"type": "input_image", "image_url": DOC_IMAGE},
                ],
            }
        ],
        "tools": [{"type": "web_search"}],
        "reasoning": {"effort": "high"},
    }
)
