/* ==========================================================================
   GateTab — community-gate denials, on their own surface
   --------------------------------------------------------------------------
   The community gate (v12.3) refuses a call with 403 until the account has
   checked into the portal that day. Those refusals used to land in Request
   logs as failures and drag the success rate down. Since v12.10 they are
   marked (community_gate_denied) and excluded from the failure math — and
   this tab is where they live instead: who was turned away, why, and how
   often, so you can tell "users have not checked in yet" apart from a real
   outage at a glance.

   Reads the admin_gate_denials view from
   supabase/upgrade-v12.10-community-gate-visibility.sql. Until that file is
   applied the list comes back empty and says so — nothing throws.

   RULES OF HOOKS: every hook is in one block at the top, before any return.
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../../components/ui/index.jsx";
import { num, relative } from "../../lib/format.js";
import { listGateDenials } from "../../lib/db.js";
import { TabHead, Empty, Stat } from "../console/parts.jsx";

const CODE_LABEL = {
  community_checkin_required: "check-in required",
  community_participation_required: "more posts required",
};

export default function GateTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await listGateDenials(300));
    } catch (err) {
      setError(err?.message || "Could not load gate denials.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* Roll the flat list up into the two numbers that matter: how many denials
     today, and how many distinct accounts were turned away. */
  const summary = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = rows.filter((r) => new Date(r.created_at) >= todayStart);
    const accounts = new Set(rows.map((r) => r.user_id).filter(Boolean));
    return {
      total: rows.length,
      today: today.length,
      accounts: accounts.size,
      last: rows[0]?.created_at || null,
    };
  }, [rows]);

  return (
    <>
      <TabHead
        title="Gate denials"
        actions={
          <Button size="sm" variant="ghost" onClick={load}>
            Refresh
          </Button>
        }
      >
        Calls the community gate turned away (no check-in / not enough posts).
        These are policy denials, not upstream failures — they no longer count
        against the success rate or appear in Request logs.
      </TabHead>

      {error ? (
        <div className="mb-4">
          <Alert tone="error" title="Could not load">
            {error}
          </Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="gate-wait">
          <Spinner size={22} />
          <p className="muted small mt-4">Loading gate denials…</p>
        </div>
      ) : (
        <>
          <div className="adm-stats">
            <Stat label="Denials today" value={num(summary.today)} sub="since midnight, local" />
            <Stat label="Denials loaded" value={num(summary.total)} sub="newest 300" />
            <Stat
              label="Accounts affected"
              value={num(summary.accounts)}
              sub="distinct users turned away"
            />
            <Stat
              label="Most recent"
              value={summary.last ? relative(summary.last) : "—"}
              sub="latest refusal"
            />
          </div>

          <div className="adm-card mt-4">
            <h3>Refusals</h3>
            <p className="sub">
              One row per refused call. The reason names which rule the account
              had not met yet.
            </p>
            {rows.length === 0 ? (
              <Empty title="No gate denials">
                Either the community gate is off, or everyone who called today
                had already checked in. If the v12.10 migration has not been
                applied yet, this list stays empty by design.
              </Empty>
            ) : (
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Account</th>
                      <th>Model</th>
                      <th>Rule</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="faint xs">{relative(r.created_at)}</td>
                        <td>{r.user_email || "—"}</td>
                        <td className="mono">{r.model_public_id || "—"}</td>
                        <td>
                          <span className="st st-rate_limited">
                            {CODE_LABEL[r.error_code] || r.error_code || "denied"}
                          </span>
                        </td>
                        <td className="faint xs">{r.error_message || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
