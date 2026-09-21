/* KIE ORIGINAL - the admin tab.
   The existing key editor, plus the two things that were missing: the model
   mapping a key publishes, and the usage behind it - both as spreadsheets. */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Segmented } from "../../components/ui/index.jsx";
import SheetGrid from "../../components/ui/SheetGrid.jsx";
import { adminUsageSheet, listKieModelMap, syncKieModels } from "../../lib/db.js";
import { num } from "../../lib/format.js";
import KieTab from "./KieTab.jsx";

const RANGES = [
  { value: 1, label: "24h" },
  { value: 7, label: "7d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
];

const SCOPES = [
  { value: "kie", label: "KIE ORIGINAL only" },
  { value: "all", label: "Every provider" },
];

const kieChip = (value) =>
  /kie original/i.test(String(value || "")) ? <span className="sheet-chip kie">KIE ORIGINAL</span> : value || "";

const MAP_COLUMNS = [
  { key: "public_id", label: "Public model id", width: 168, mono: true },
  { key: "display_name", label: "Shown as", width: 172 },
  { key: "upstream_model_id", label: "Sent to KIE as", width: 158, mono: true },
  {
    key: "is_catch_all",
    label: "Catch-all",
    type: "bool",
    width: 100,
    render: (r) => (r.is_catch_all ? <span className="sheet-chip kie">catch-all</span> : ""),
  },
  { key: "alias_count", label: "Aliases", type: "int", width: 86, total: false },
  {
    key: "status",
    label: "Status",
    width: 104,
    render: (r) => (
      <span className={`sheet-chip ${r.is_active && r.status === "active" ? "ok" : "bad"}`}>
        {r.is_active ? r.status || "unknown" : "inactive"}
      </span>
    ),
  },
  { key: "keys_usable", label: "Keys usable", type: "int", width: 108, total: false },
  { key: "keys_total", label: "Keys", type: "int", width: 76, total: false },
  { key: "context_window", label: "Context", type: "int", width: 102, total: false },
  { key: "max_output_tokens", label: "Max out", type: "int", width: 98, total: false },
  { key: "aliases", label: "Alias list", width: 300, mono: true },
];

const USAGE_COLUMNS = [
  { key: "created_at", label: "When", type: "datetime", width: 166 },
  { key: "account", label: "Account", width: 196 },
  { key: "model", label: "Model", width: 148, mono: true },
  { key: "provider", label: "Provider", width: 130, render: (r) => kieChip(r.provider) },
  { key: "dialect", label: "Dialect", width: 94 },
  { key: "harness", label: "Harness", width: 116 },
  { key: "policy", label: "Policy", width: 106 },
  {
    key: "ok",
    label: "Result",
    type: "bool",
    width: 84,
    render: (r) => <span className={`sheet-chip ${r.ok ? "ok" : "bad"}`}>{r.ok ? "ok" : "failed"}</span>,
  },
  { key: "status_code", label: "Status", type: "int", width: 76, total: false },
  { key: "latency_ms", label: "Latency", type: "ms", width: 98, total: false },
  { key: "tokens_in", label: "Tokens in", type: "tokens", width: 94 },
  { key: "tokens_out", label: "Tokens out", type: "tokens", width: 102 },
  { key: "tokens_total", label: "Tokens", type: "tokens", width: 94 },
  { key: "cost_usd", label: "Cost", type: "money", width: 94 },
  { key: "key_label", label: "Upstream key", width: 146 },
  { key: "request_id", label: "Request id", width: 186, mono: true },
  { key: "error_code", label: "Error", width: 138 },
];

const MIGRATION_NOTE =
  "Apply supabase/upgrade-v11.6-kie-original.sql to publish KIE ORIGINAL into model mapping and record the dialect and harness of every request.";

export default function KieOriginalTab() {
  const [mapRows, setMapRows] = useState([]);
  const [usage, setUsage] = useState([]);
  const [days, setDays] = useState(30);
  const [scope, setScope] = useState("kie");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async (forDays, forScope) => {
    setBusy(true);
    try {
      const [map, sheet] = await Promise.all([
        listKieModelMap(),
        adminUsageSheet({ days: forDays, limit: 2000, kieOnly: forScope === "kie" }),
      ]);
      setMapRows(map ?? []);
      setUsage(sheet ?? []);
      setNote(sheet === null ? MIGRATION_NOTE : "");
    } catch (err) {
      setNote(err?.message || MIGRATION_NOTE);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(days, scope);
  }, [days, scope, load]);

  async function onSync() {
    setSyncing(true);
    setMsg("");
    try {
      const models = await syncKieModels();
      setMsg(`${num(models)} model${models === 1 ? "" : "s"} published into model mapping.`);
      await load(days, scope);
    } catch (err) {
      setMsg(err?.message || "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const catchAll = useMemo(() => mapRows.find((r) => r.is_catch_all), [mapRows]);
  const kieRequests = useMemo(() => usage.filter((r) => /kie original/i.test(String(r.provider || ""))).length, [usage]);

  return (
    <div className="kie-original">
      <KieTab />

      {note ? <Alert tone="info">{note}</Alert> : null}
      {msg ? <Alert tone="ok">{msg}</Alert> : null}

      <div className="sheet-head">
        <div className="sheet-heading">
          <span className="sheet-title">Model mapping</span>
          <span className="sheet-sub">
            {catchAll
              ? `${catchAll.public_id} answers any unknown model id, so hard-coded Claude and GPT ids work too`
              : "every key you add publishes its models here"}
          </span>
        </div>
        <div className="sheet-tools">
          {/* `loading`, not `busy`: Button spreads unknown props straight onto
              the DOM <button>, so busy={false} rendered busy="false" and React
              logged "Received `false` for a non-boolean attribute". loading={}
              is the real prop — it disables the button and shows the spinner,
              which is what this was always trying to do. */}
          <Button variant="ghost" onClick={onSync} loading={syncing} disabled={syncing}>
            Sync models
          </Button>
        </div>
      </div>

      <SheetGrid
        title="KIE ORIGINAL models"
        subtitle={`${num(mapRows.length)} published`}
        columns={MAP_COLUMNS}
        rows={mapRows}
        loading={busy}
        filename="kie-original-models.csv"
        emptyLabel="No models yet - add a key above, then press Sync models."
        maxHeight={340}
      />

      <div className="sheet-head">
        <div className="sheet-heading">
          <span className="sheet-title">Usage</span>
          <span className="sheet-sub">
            {kieRequests
              ? `${num(kieRequests)} request${kieRequests === 1 ? "" : "s"} served by KIE ORIGINAL`
              : "per request, with the dialect and harness that called it"}
          </span>
        </div>
        <div className="sheet-tools">
          <Segmented options={RANGES} value={days} onChange={setDays} ariaLabel="Date range" />
          <Segmented options={SCOPES} value={scope} onChange={setScope} ariaLabel="Scope" />
        </div>
      </div>

      <SheetGrid
        title="Usage sheet"
        subtitle={`${num(usage.length)} rows / last ${days}d`}
        columns={USAGE_COLUMNS}
        rows={usage}
        loading={busy}
        filename={`kie-original-usage-${days}d.csv`}
        emptyLabel="No requests in this range yet."
      />
    </div>
  );
}
