/* ==========================================================================
   Credits
   --------------------------------------------------------------------------
   Prepaid USD balance for the signed-in account. The balance itself lives on
   profiles.credit_balance_usd; every movement is a row in credit_ledger, and
   the router debits the metered cost of each request automatically.
   ========================================================================== */

import React from "react";
import { Alert, Button } from "../../components/ui/index.jsx";
import { dateTime, money, num, relative } from "../../lib/format.js";
import { Empty, Stat, TabHead } from "./parts.jsx";

const KIND_LABEL = {
  signup_grant: "Welcome credit",
  admin_grant: "Added by admin",
  admin_deduct: "Removed by admin",
  topup: "Top-up",
  usage: "Usage",
  refund: "Refund",
  adjustment: "Adjustment",
};

function Amount({ value }) {
  const n = Number(value || 0);
  const cls = n < 0 ? "credit-out" : "credit-in";
  return (
    <span className={cls}>
      {n < 0 ? "−" : "+"}
      {money(Math.abs(n))}
    </span>
  );
}

export default function CreditsTab({
  credits = null,
  ledger = [],
  onRefresh,
  onGo,
  isAdmin = false,
}) {
  /* the SQL upgrade has not been applied yet */
  if (credits?.unavailable) {
    return (
      <>
        <TabHead title="Credits">
          A prepaid balance, metered per request at your published model prices.
        </TabHead>
        <Alert tone="warn" title="Credits are not installed yet">
          Open the Supabase SQL editor, paste{" "}
          <code>supabase/upgrade-v5.4.sql</code> from this project and press Run.
          That adds the balance column, the ledger table and the gateway hooks —
          then reload this page.
        </Alert>
      </>
    );
  }

  const balance = Number(credits?.balance_usd || 0);
  const added = Number(credits?.added_usd || 0);
  const used = Number(credits?.used_usd || 0);
  const burn = Number(credits?.daily_burn_usd || 0);
  const enforced = Boolean(credits?.enforced);
  const low = Boolean(credits?.low);
  const overdraft = Number(credits?.overdraft_usd || 0);
  const floor = -Math.abs(overdraft);
  const runway = burn > 0 ? Math.max(0, Math.floor((balance - floor) / burn)) : null;

  return (
    <>
      <TabHead
        title="Credits"
        actions={
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        }
      >
        Every request is priced at the model's published rate and debited from
        this balance the moment it completes.
      </TabHead>

      {balance <= floor && enforced ? (
        <div className="mb-4">
          <Alert tone="error" title="Out of credits">
            The gateway is refusing requests with{" "}
            <code>402 insufficient_credits</code>.{" "}
            {isAdmin
              ? "Add credit from Admin → Credits."
              : "Ask a workspace admin to top up this account."}
          </Alert>
        </div>
      ) : low ? (
        <div className="mb-4">
          <Alert tone="warn" title="Low balance">
            {money(balance)} left{runway != null ? ` — about ${runway} day${runway === 1 ? "" : "s"} at your current burn rate` : ""}.
          </Alert>
        </div>
      ) : null}

      <div className="credit-hero">
        <div>
          <span className="l">Available balance</span>
          <b className={balance <= floor ? "v is-zero" : "v"}>{money(balance)}</b>
          <span className="s">
            {enforced
              ? overdraft > 0
                ? `Requests stop at −${money(Math.abs(overdraft))}`
                : "Requests stop when this reaches $0.00"
              : "Enforcement is off — requests still run at $0.00"}
          </span>
        </div>
        <div className="credit-hero-meta">
          <div>
            <span className="l">Burn rate</span>
            <b>{money(burn)}/day</b>
          </div>
          <div>
            <span className="l">Runway</span>
            <b>{runway == null ? "—" : `${num(runway)} days`}</b>
          </div>
          <div>
            <span className="l">Last top-up</span>
            <b>{credits?.last_topup_at ? relative(credits.last_topup_at) : "never"}</b>
          </div>
        </div>
      </div>

      <div className="adm-stats mt-4">
        <Stat label="Credit added" value={money(added)} sub="lifetime" />
        <Stat label="Credit used" value={money(used)} sub="lifetime" />
        <Stat
          label="Spend (30 days)"
          value={money(credits?.spend_30d || 0)}
          sub={`${num(credits?.requests_30d || 0)} requests`}
        />
        <Stat label="Spend (24 hours)" value={money(credits?.spend_24h || 0)} sub="rolling" />
      </div>

      <div className="adm-card mt-4">
        <h3>How top-ups work</h3>
        <p className="sub">
          Credit is issued from the admin panel, so there is no card on file and
          nothing to cancel.
        </p>
        <ul className="credit-steps">
          <li>
            New accounts start with the welcome credit set in Admin → Settings.
          </li>
          <li>
            An admin adds any amount from Admin → Credits; it lands here
            instantly and is written to the ledger below.
          </li>
          <li>
            Each completed request is debited at{" "}
            <code>tokens × model price</code>. Failed requests cost nothing.
          </li>
          <li>
            Per-key monthly budgets still apply on top, so one key cannot drain
            the whole balance.
          </li>
        </ul>
        <div className="adm-form-actions">
          {isAdmin ? (
            <Button as="a" href="#/admin?tab=credits" size="sm" variant="primary">
              Open Admin → Credits
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onGo?.("logs")}>
            See what you spent it on
          </Button>
        </div>
      </div>

      <div className="adm-card mt-4">
        <h3>Ledger</h3>
        <p className="sub">Every movement, newest first.</p>
        {ledger.length === 0 ? (
          <Empty title="Nothing yet">
            Grants and usage charges will appear here as soon as the balance
            moves.
          </Empty>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Detail</th>
                  <th className="num">Amount</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((row) => (
                  <tr key={row.id}>
                    <td className="faint xs">{dateTime(row.created_at)}</td>
                    <td>{KIND_LABEL[row.kind] || row.kind}</td>
                    <td>
                      <span className="small">{row.description || "—"}</span>
                      {row.request_id ? (
                        <div className="faint xs mono">{row.request_id}</div>
                      ) : null}
                    </td>
                    <td className="num">
                      <Amount value={row.delta_usd} />
                    </td>
                    <td className="num">{money(row.balance_after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
