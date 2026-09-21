/* ==========================================================================
   Referrals
   --------------------------------------------------------------------------
   One link, one code, and what it has earned. Invitee addresses arrive already
   masked from the my_referrals view — an inviter should be able to see that
   someone joined without walking away with a clean list of email addresses.
   ========================================================================== */

import React, { useState } from "react";
import { Alert, Button, TextInput } from "../../components/ui/index.jsx";
import { copy, money, num, relative } from "../../lib/format.js";
import { Empty, Stat, StatusChip, TabHead } from "./parts.jsx";

export default function ReferralsTab({
  referral = null,
  referrals = [],
  link = "",
  onRefresh,
}) {
  const [copied, setCopied] = useState("");

  const grab = async (value, which) => {
    if (!value) return;
    await copy(value);
    setCopied(which);
    setTimeout(() => setCopied(""), 1600);
  };

  if (referral?.unavailable) {
    return (
      <>
        <TabHead title="Referrals">Invite links and rewards.</TabHead>
        <Alert tone="info" title="Not enabled yet">
          Run <code className="mono">supabase/upgrade-v5.9-referrals.sql</code> in the SQL
          editor, then reload.
        </Alert>
      </>
    );
  }

  const code = referral?.code || "—";
  const off = referral && referral.enabled === false;
  const manual = referral?.reward_on === "manual";

  return (
    <>
      <TabHead
        title="Referrals"
        actions={
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        }
      >
        Share your link. Both sides get credit when someone joins.
      </TabHead>

      {off ? (
        <div className="mb-4">
          <Alert tone="warning" title="Referrals are switched off">
            Your link still works, but no credit is granted while an admin has the programme
            disabled.
          </Alert>
        </div>
      ) : null}

      <div className="adm-stats">
        <Stat label="Invited" value={num(referral?.invited || 0)} sub="accounts created" />
        <Stat label="Rewarded" value={num(referral?.rewarded || 0)} sub="paid out" />
        <Stat
          label="Earned"
          value={money(referral?.earned_usd || 0)}
          sub="credit, lifetime"
          tone={Number(referral?.earned_usd || 0) > 0 ? "ok" : undefined}
        />
        <Stat
          label="Per signup"
          value={money(referral?.reward_usd || 0)}
          sub={`they get ${money(referral?.bonus_usd || 0)}`}
        />
      </div>

      <div className="adm-card mt-5">
        <h3>Your link</h3>
        <p className="sub">Anyone who signs up through it is attributed to you.</p>

        <div className="reveal-box">
          <code>{link || "—"}</code>
          <Button size="sm" variant="ghost" onClick={() => grab(link, "link")}>
            {copied === "link" ? "Copied" : "Copy"}
          </Button>
        </div>

        <div className="adm-grid mt-4">
          <div>
            <span className="adm-label">Code</span>
            <div className="row gap-2">
              <TextInput value={code} readOnly aria-label="Your referral code" />
              <Button size="sm" variant="ghost" onClick={() => grab(code, "code")}>
                {copied === "code" ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="faint xs mt-2">
              Works typed into the signup form too, if the link gets mangled.
            </p>
          </div>
          {referral?.referred_by ? (
            <div>
              <span className="adm-label">You were invited by</span>
              <p className="mono small">{referral.referred_by}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="adm-card mt-4">
        <h3>Who joined</h3>
        <p className="sub">
          {manual
            ? "Rewards are reviewed by an admin before they land."
            : "Credit is granted the moment the account is created."}
        </p>

        {referrals.length === 0 ? (
          <Empty title="Nobody yet">
            Send the link above. Signups show up here as soon as they land.
          </Empty>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Invitee</th>
                  <th>Status</th>
                  <th className="num">Reward</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.invitee}</td>
                    <td>
                      <StatusChip
                        value={
                          r.status === "rewarded"
                            ? "working"
                            : r.status === "void"
                            ? "disabled"
                            : "unknown"
                        }
                      />
                    </td>
                    <td className="num">
                      {r.status === "rewarded" ? money(r.reward_usd) : "—"}
                    </td>
                    <td className="faint xs">{relative(r.created_at)}</td>
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
