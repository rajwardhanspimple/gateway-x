/* ==========================================================================
   API keys
   --------------------------------------------------------------------------
   Laid out as a tree instead of a table. Keys are already filed by
   environment, so the environment becomes the folder and the key becomes the
   file inside it — the grouping is shown once, in the indent, rather than
   repeated down a column. Selecting a key opens it on the right.
   ========================================================================== */

import React, { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Field,
  Segmented,
  TextInput,
} from "../../components/ui/index.jsx";
import { CheckIcon } from "../../components/ui/icons.jsx";
import { Explorer, Tree, TreeDetail } from "../../components/ui/Tree.jsx";
import { copy, money, num, relative } from "../../lib/format.js";
import { Stat, StatusChip, TabHead } from "./parts.jsx";

const TONE = { active: "ok", revoked: "danger", expired: "warn" };

export default function KeysTab({
  keys = [],
  onCreate,
  onRevoke,
  onRename,
  onBudget,
  onIpRules,
  onUseInPlayground,
}) {
  const [name, setName] = useState("");
  const [env, setEnv] = useState("live");
  const [budget, setBudget] = useState("");
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(null);

  const active = keys.filter((k) => k.status === "active");
  const spend = keys.reduce((a, k) => a + Number(k.spend_usd || 0), 0);
  const calls = keys.reduce((a, k) => a + Number(k.request_count || 0), 0);

  /* ------------------------------------------------------------- the tree */
  const folders = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (k) =>
      !needle ||
      [k.name, k.masked_key, k.environment, k.status]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);

    /* Live first, then test, then anything an older row used. */
    const order = ["live", "test"];
    const seen = [...new Set(keys.map((k) => k.environment || "live"))].sort(
      (a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9)
    );

    return seen.map((environment) => ({
      id: environment,
      name: `${environment}/`,
      meta: environment === "live" ? "billed" : "sandbox",
      files: keys
        .filter((k) => (k.environment || "live") === environment && match(k))
        .map((k) => ({
          id: k.id,
          name: k.name || "untitled",
          meta: k.masked_key,
          badge: k.status,
          tone: TONE[k.status] || null,
          row: k,
        })),
    }));
  }, [keys, q]);

  const shown = folders.reduce((a, f) => a + f.files.length, 0);
  const selected =
    folders.flatMap((f) => f.files).find((f) => f.id === picked)?.row ?? null;
  const selectedFolder = keys.find((k) => k.id === picked)?.environment || "live";

  const submit = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCopied(false);
    setErr("");
    try {
      const row = await onCreate({
        name: name || `${env} key`,
        environment: env,
        budget: budget === "" ? null : Number(budget),
      });
      if (row?.api_key) {
        setFresh(row);
        setName("");
        setBudget("");
        setShowForm(false);
      } else {
        setErr(
          "Saved, but no key came back. Reload and check the tree before creating another."
        );
      }
    } catch (e2) {
      /* shown next to the form — a page-level banner is easy to miss */
      setErr(e2?.message || "Could not create the key.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <TabHead title="API keys">
        Shown in full once, at creation. Only a SHA-256 hash is stored.
      </TabHead>

      <div className="adm-stats">
        <Stat label="Active" value={num(active.length)} sub={`${keys.length} issued`} />
        <Stat label="Requests" value={num(calls)} sub="all keys" />
        <Stat label="Spend" value={money(spend)} sub="all keys" />
        <Stat
          label="Capped"
          value={num(keys.filter((k) => k.monthly_budget_usd != null).length)}
          sub="have a budget"
        />
      </div>

      {fresh?.api_key ? (
        <div className="key-new mt-5">
          <b className="row gap-2">
            <CheckIcon width={15} height={15} /> Copy it now
          </b>
          <p className="muted small mt-2">This value is never shown again.</p>
          <div className="reveal-box">
            <code>{fresh.api_key}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await copy(fresh.api_key);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="adm-form-actions">
            <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
              Done
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onUseInPlayground(fresh.api_key)}
            >
              Use in playground
            </Button>
          </div>
        </div>
      ) : null}

      {showForm ? (
        <div className="adm-card mt-5">
          <h3>New key</h3>
          <p className="sub">Test keys behave the same but are safe to rotate.</p>
          {err ? (
            <div className="mb-4">
              <Alert tone="error" title="Not created">
                {err}
              </Alert>
            </div>
          ) : null}
          <form className="adm-grid" onSubmit={submit}>
            <Field label="Name" htmlFor="key-name" optional>
              <TextInput
                id="key-name"
                placeholder="production backend"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div>
              <span className="adm-label">Environment</span>
              <Segmented
                ariaLabel="Key environment"
                value={env}
                onChange={setEnv}
                options={[
                  { value: "live", label: "Live" },
                  { value: "test", label: "Test" },
                ]}
              />
            </div>
            <Field label="Monthly cap (USD)" htmlFor="key-budget" optional hint="Blank = none">
              <TextInput
                id="key-budget"
                type="number"
                min="0"
                step="0.01"
                placeholder="25"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <div className="con-form-submit">
              <Button type="submit" variant="primary" loading={creating} block>
                Create
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      <div className="mt-5">
        <Explorer
          toolbar={
            <>
              <div className="con-search">
                <TextInput
                  placeholder="Filter keys"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  aria-label="Filter keys"
                />
              </div>
              <span className="faint xs mono">
                {shown}/{keys.length}
              </span>
              <span className="tr-toolbar-spacer" />
              <Button
                size="sm"
                variant={showForm ? "ghost" : "primary"}
                onClick={() => setShowForm((v) => !v)}
              >
                {showForm ? "Cancel" : "New key"}
              </Button>
            </>
          }
        >
          <Tree
            label="API keys by environment"
            folders={folders}
            selectedId={picked}
            onSelect={(id) => setPicked(id)}
          />

          {!selected ? (
            <TreeDetail
              empty={
                keys.length === 0
                  ? "No keys yet. Create one to get a gateway credential."
                  : "Pick a key to see its usage, cap and IP rules."
              }
            />
          ) : (
            <TreeDetail
              path={`keys/${selectedFolder}/${selected.name || "untitled"}`}
              title={selected.name || "untitled"}
              sub={selected.masked_key}
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={() => onRename(selected.id, selected.name)}>
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onBudget(selected.id, selected.monthly_budget_usd)}
                  >
                    Cap
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onIpRules(selected.id, selected)}>
                    IP rules
                  </Button>
                  {selected.status === "active" ? (
                    <Button size="sm" variant="danger" onClick={() => onRevoke(selected.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </>
              }
              rows={[
                ["status", <StatusChip value={selected.status} />],
                ["environment", selected.environment || "live"],
                ["requests", num(selected.request_count || 0)],
                ["spend", money(selected.spend_usd || 0)],
                [
                  "monthly cap",
                  selected.monthly_budget_usd == null
                    ? "none"
                    : money(selected.monthly_budget_usd),
                ],
                [
                  "allowed IPs",
                  (selected.allowed_ips?.length ?? 0) === 0 ? (
                    "any"
                  ) : (
                    <span className="mono xs">{selected.allowed_ips.join(", ")}</span>
                  ),
                ],
                selected.ip_rate_limit_rpm
                  ? ["per-IP limit", `${selected.ip_rate_limit_rpm}/min`]
                  : null,
                ["last used", selected.last_used_at ? relative(selected.last_used_at) : "never"],
                selected.created_at ? ["created", relative(selected.created_at)] : null,
              ]}
            />
          )}
        </Explorer>
      </div>
    </>
  );
}
