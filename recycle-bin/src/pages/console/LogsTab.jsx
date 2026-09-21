/* Console -> Usage. A spreadsheet of every request: what was asked, which
   dialect and harness asked it, how long it took and what it cost. */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Segmented } from "../../components/ui/index.jsx";
import SheetGrid from "../../components/ui/SheetGrid.jsx";
import { usageSheet } from "../../lib/db.js";
import { num } from "../../lib/format.js";
import { TabHead } from "./parts.jsx";

const RANGES = [
  { value: 1, label: "24h" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
];

const COLUMNS = [
  { key: "created_at", label: "When", type: "datetime", width: 166 },
  { key: "model", label: "Model", width: 150, mono: true },
  {
    key: "provider",
    label: "Provider",
    width: 132,
    render: (r) =>
      /kie original/i.test(String(r.provider || "")) ? (
        <span className="sheet-chip kie">KIE ORIGINAL</span>
      ) : (
        r.provider || ""
      ),
  },
  { key: "dialect", label: "Dialect", width: 96 },
  { key: "harness", label: "Harness", width: 118 },
  { key: "policy", label: "Policy", width: 106 },
  {
    key: "ok",
    label: "Result",
    type: "bool",
    width: 86,
    render: (r) => <span className={`sheet-chip ${r.ok ? "ok" : "bad"}`}>{r.ok ? "ok" : "failed"}</span>,
  },
  { key: "status_code", label: "Status", type: "int", width: 78, total: false },
  { key: "latency_ms", label: "Latency", type: "ms", width: 98, total: false },
  { key: "tokens_in", label: "Tokens in", type: "tokens", width: 96 },
  { key: "tokens_out", label: "Tokens out", type: "tokens", width: 104 },
  { key: "tokens_total", label: "Tokens", type: "tokens", width: 96 },
  { key: "cost_usd", label: "Cost", type: "money", width: 96 },
  { key: "streamed", label: "Streamed", type: "bool", width: 96 },
  { key: "request_id", label: "Request id", width: 188, mono: true },
  { key: "error_code", label: "Error", width: 140 },
];

/* Used until the v11.6 migration is applied: shape the old log rows the same way. */
function fromLogs(logs) {
  return (logs ?? []).map((l) => ({
    created_at: l.created_at,
    request_id: l.request_id,
    model: l.model_public_id ?? l.model ?? "",
    provider: l.provider ?? l.upstreams?.name ?? "",
    dialect: l.dialect ?? "chat",
    harness: l.harness ?? "api",
    policy: l.policy ?? "",
    ok: !!l.ok,
    status_code: l.status_code,
    latency_ms: l.latency_ms,
    tokens_in: l.tokens_in ?? 0,
    tokens_out: l.tokens_out ?? 0,
    tokens_total: (l.tokens_in ?? 0) + (l.tokens_out ?? 0),
    cost_usd: l.cost_usd ?? 0,
    streamed: !!l.streamed,
    error_code: l.error_code ?? "",
    kie: /kie/i.test(String(l.provider ?? l.upstreams?.name ?? "")),
  }));
}

export default function LogsTab({ logs = [], onRefresh }) {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);

  const load = useCallback(async (forDays) => {
    setBusy(true);
    try {
      const sheet = await usageSheet({ days: forDays, limit: 2000 });
      setFallback(sheet === null);
      setRows(sheet ?? []);
    } catch {
      setFallback(true);
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const data = useMemo(() => (fallback ? fromLogs(logs) : rows), [fallback, logs, rows]);
  const kieRows = useMemo(
    () => data.filter((r) => r.kie || /kie original/i.test(String(r.provider || ""))).length,
    [data],
  );

  async function refresh() {
    await load(days);
    if (onRefresh) await onRefresh();
  }

  return (
    <div className="con-tab">
      <TabHead title="Usage">
        Every request as a row, with the dialect and harness that asked for it.
      </TabHead>

      <div className="sheet-tools">
        <Segmented options={RANGES} value={days} onChange={setDays} ariaLabel="Date range" />
        <Button variant="ghost" onClick={refresh} busy={busy} disabled={busy}>
          Refresh
        </Button>
      </div>

      <SheetGrid
        title="Requests"
        subtitle={
          kieRows
            ? `${num(data.length)} rows / ${num(kieRows)} via KIE ORIGINAL`
            : `${num(data.length)} rows / last ${days}d`
        }
        columns={COLUMNS}
        rows={data}
        loading={busy}
        filename={`usage-${days}d.csv`}
        emptyLabel="No requests in this range yet."
      />
    </div>
  );
}
