import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Spinner } from "../../components/ui/index.jsx";
import { ShieldIcon, BoltIcon } from "../../components/ui/icons.jsx";
import { num, relative, dateTime } from "../../lib/format.js";
import {
  adminIpRegistry,
  blockIp,
  exemptIp,
  forgetIp,
  getIpSettings,
  listBlockedIps,
  listUsers,
  saveIpSettings,
  setUserIpRules,
  unblockIp,
} from "../../lib/db.js";

/* ============================================================================
   Admin -> IP limits
   ----------------------------------------------------------------------------
   Every address the gateway sees is recorded by internal_ip_check() into
   public.ip_registry, whether or not the request was allowed. This screen is
   the only place those recordings turn into rules.

   Reading order matches the order the database evaluates them, so what you
   see top to bottom is what a request goes through.
============================================================================ */

function L({ children, hint }) {
  return (
    <span className="adm-label">
      {children}
      {hint ? <span className="faint xs"> {hint}</span> : null}
    </span>
  );
}

const WINDOWS = [
  { id: 1, label: "last hour" },
  { id: 24, label: "last 24 hours" },
  { id: 168, label: "last 7 days" },
  { id: 720, label: "last 30 days" },
  { id: 8760, label: "last year" },
];

const EMPTY = {
  ip_limits_enabled: false,
  ip_rate_limit_rpm: 0,
  ip_rate_limit_rph: 0,
  ip_max_distinct_per_hour: 0,
  ip_max_accounts_per_ip: 0,
  ip_autoblock_minutes: 0,
  ip_allowlist_required: false,
  ip_denylist: [],
  ip_exempt_ips: [],
  ip_registry_retain_days: 180,
};

const asList = (text) =>
  String(text || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function IpTab() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const [form, setForm] = useState(EMPTY);
  const [rows, setRows] = useState([]);
  const [bans, setBans] = useState([]);
  const [users, setUsers] = useState([]);

  const [hours, setHours] = useState(168);
  const [search, setSearch] = useState("");
  const [newExempt, setNewExempt] = useState("");
  const [newBan, setNewBan] = useState({ cidr: "", reason: "", minutes: "" });
  const [pickUser, setPickUser] = useState("");

  const flash = (msg) => {
    setOk(msg);
    setError("");
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setOk(""), 4000);
  };

  const load = useCallback(async () => {
    setError("");
    try {
      const [s, r, b, u] = await Promise.all([
        getIpSettings(),
        adminIpRegistry({ hours, search }),
        listBlockedIps(),
        listUsers(),
      ]);
      setForm({ ...EMPTY, ...(s || {}) });
      setRows(r || []);
      setBans(b || []);
      setUsers(u || []);
    } catch (err) {
      setError(
        /admin_get_ip_settings|does not exist|schema cache|could not find/i.test(err.message || "")
          ? "Run supabase/upgrade-v5.7-ip-admin.sql in the Supabase SQL editor first — this screen needs the RPCs it installs."
          : err.message || "Could not load IP data.",
      );
    } finally {
      setLoading(false);
    }
  }, [hours, search]);

  useEffect(() => {
    load();
  }, [load]);

  /* ----------------------------------------------------------- mutations */

  const run = async (tag, fn, msg) => {
    setBusy(tag);
    setError("");
    try {
      await fn();
      await load();
      if (msg) flash(msg);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const savePatch = (patch, msg) =>
    run("settings", () => saveIpSettings(patch), msg || "IP settings saved.");

  const submitLimits = (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    savePatch({
      ip_limits_enabled: f.get("ip_limits_enabled") === "yes",
      ip_rate_limit_rpm: Number(f.get("ip_rate_limit_rpm")) || 0,
      ip_rate_limit_rph: Number(f.get("ip_rate_limit_rph")) || 0,
      ip_max_distinct_per_hour: Number(f.get("ip_max_distinct_per_hour")) || 0,
      ip_max_accounts_per_ip: Number(f.get("ip_max_accounts_per_ip")) || 0,
      ip_autoblock_minutes: Number(f.get("ip_autoblock_minutes")) || 0,
      ip_allowlist_required: f.get("ip_allowlist_required") === "yes",
      ip_registry_retain_days: Number(f.get("ip_registry_retain_days")) || 180,
    });
  };

  /* ------------------------------------------------------------- derived */

  const enforcing = form.ip_limits_enabled;
  const anyLimit =
    Number(form.ip_rate_limit_rpm) > 0 ||
    Number(form.ip_rate_limit_rph) > 0 ||
    Number(form.ip_max_distinct_per_hour) > 0 ||
    Number(form.ip_max_accounts_per_ip) > 0 ||
    form.ip_allowlist_required;

  const unlimited = useMemo(
    () => users.filter((u) => u.ip_limit_exempt || Number(u.ip_rate_limit_rpm) > 0),
    [users],
  );
  const limitable = useMemo(
    () => users.filter((u) => !u.ip_limit_exempt && !Number(u.ip_rate_limit_rpm)),
    [users],
  );

  const totals = useMemo(
    () => ({
      addresses: new Set(rows.map((r) => r.ip)).size,
      requests: rows.reduce((a, r) => a + Number(r.requests || 0), 0),
      refused: rows.reduce((a, r) => a + Number(r.refused || 0), 0),
    }),
    [rows],
  );

  if (loading) {
    return (
      <div className="gate-wait">
        <Spinner size={20} /> Loading IP data
      </div>
    );
  }

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>IP limits</h1>
          <p>
            Every caller address is recorded in <code>ip_registry</code> before the request is
            routed. Nothing below is enforced until you switch it on.
          </p>
        </div>
        <div className="acts">
          <Button size="sm" variant="ghost" onClick={load}>
            Refresh
          </Button>
        </div>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {ok ? <Alert tone="ok">{ok}</Alert> : null}

      <div className="adm-stats">
        <div className="adm-stat">
          <div className="l">Enforcement</div>
          <div className="v">{enforcing ? "On" : "Off"}</div>
          <div className="s">{enforcing ? "limits apply" : "recording only"}</div>
        </div>
        <div className="adm-stat">
          <div className="l">Addresses recorded</div>
          <div className="v">{num(totals.addresses)}</div>
          <div className="s">in the selected window</div>
        </div>
        <div className="adm-stat">
          <div className="l">Requests seen</div>
          <div className="v">{num(totals.requests)}</div>
          <div className="s">{num(totals.refused)} refused</div>
        </div>
        <div className="adm-stat">
          <div className="l">Accounts never limited</div>
          <div className="v">{num(users.filter((u) => u.ip_limit_exempt).length)}</div>
          <div className="s">{num(bans.length)} addresses banned</div>
        </div>
      </div>

      {enforcing && !anyLimit ? (
        <Alert tone="warn">
          Enforcement is on but every ceiling is 0, which means unlimited. Set at least a
          requests/minute number below for it to do anything.
        </Alert>
      ) : null}

      {/* ===================================================== 1. the dials === */}
      <form className="adm-card" onSubmit={submitLimits}>
        <h3>
          <BoltIcon width={15} height={15} /> Workspace limits
        </h3>
        <p className="sub">
          The default for every account. A 0 means no limit. An account or a key can override
          any of these, and an exempt account ignores all of them.
        </p>
        <div className="adm-grid">
          <div>
            <L>Enforce IP limits</L>
            <select
              className="adm-select"
              name="ip_limits_enabled"
              defaultValue={form.ip_limits_enabled ? "yes" : "no"}
            >
              <option value="no">No — record addresses only</option>
              <option value="yes">Yes — apply the rules below</option>
            </select>
          </div>
          <div>
            <L hint="0 = unlimited">Requests / minute per IP</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              name="ip_rate_limit_rpm"
              defaultValue={form.ip_rate_limit_rpm ?? 0}
            />
          </div>
          <div>
            <L hint="0 = unlimited">Requests / hour per IP</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              name="ip_rate_limit_rph"
              defaultValue={form.ip_rate_limit_rph ?? 0}
            />
          </div>
          <div>
            <L hint="key-sharing guard">Distinct IPs per key / hour</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              name="ip_max_distinct_per_hour"
              defaultValue={form.ip_max_distinct_per_hour ?? 0}
            />
          </div>
          <div>
            <L hint="multi-account guard">Accounts per IP</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              name="ip_max_accounts_per_ip"
              defaultValue={form.ip_max_accounts_per_ip ?? 0}
            />
          </div>
          <div>
            <L hint="0 = never auto-ban">Auto-ban a flood for (minutes)</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              name="ip_autoblock_minutes"
              defaultValue={form.ip_autoblock_minutes ?? 0}
            />
          </div>
          <div>
            <L>Keys must declare their IPs</L>
            <select
              className="adm-select"
              name="ip_allowlist_required"
              defaultValue={form.ip_allowlist_required ? "yes" : "no"}
            >
              <option value="no">No</option>
              <option value="yes">Yes — refuse keys with an empty allowlist</option>
            </select>
          </div>
          <div>
            <L hint="address book pruning">Keep recorded IPs for (days)</L>
            <input
              className="adm-input"
              type="number"
              min="1"
              name="ip_registry_retain_days"
              defaultValue={form.ip_registry_retain_days ?? 180}
            />
          </div>
        </div>
        <div className="adm-form-actions">
          <Button type="submit" variant="primary" size="sm" disabled={busy === "settings"}>
            {busy === "settings" ? "Saving" : "Save limits"}
          </Button>
        </div>
      </form>

      {/* ======================================== 2. accounts you never limit === */}
      <div className="adm-card">
        <h3>
          <ShieldIcon width={15} height={15} /> Accounts and their limits
        </h3>
        <p className="sub">
          An exempt account skips the rate limit, the key-sharing guard and the allowlist
          requirement no matter how busy its addresses get. A targeted ban still applies, so an
          exemption can never be used to make an account unbannable.
        </p>

        <div className="adm-grid two">
          <div>
            <L>Stop limiting an account</L>
            <select
              className="adm-select"
              value={pickUser}
              onChange={(e) => setPickUser(e.target.value)}
            >
              <option value="">Choose an account…</option>
              {limitable.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                  {u.full_name ? ` · ${u.full_name}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ alignSelf: "end" }}>
            <Button
              size="sm"
              variant="primary"
              disabled={!pickUser || busy === "exempt-user"}
              onClick={() =>
                run(
                  "exempt-user",
                  async () => {
                    await setUserIpRules(pickUser, { exempt: true });
                    setPickUser("");
                  },
                  "That account is no longer subject to IP limits.",
                )
              }
            >
              Never limit this account
            </Button>
          </div>
        </div>

        {unlimited.length === 0 ? (
          <div className="adm-empty">
            <b>Every account uses the workspace defaults</b>
            Exempt an account above, or give one its own ceiling in the table once it appears
            here.
          </div>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>IP limits</th>
                  <th>Own ceiling</th>
                  <th className="num">Known IPs</th>
                  <th className="num">Req 30d</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unlimited.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <b>{u.email}</b>
                      <div className="faint xs">{u.full_name || "—"}</div>
                    </td>
                    <td>
                      <span className={`st st-${u.ip_limit_exempt ? "disabled" : "working"}`}>
                        {u.ip_limit_exempt ? "exempt" : "limited"}
                      </span>
                    </td>
                    <td>
                      {u.ip_limit_exempt ? (
                        <span className="faint xs">no limit applies</span>
                      ) : (
                        <RpmCell
                          user={u}
                          busy={busy === `rpm-${u.id}`}
                          onSave={(rpm) =>
                            run(
                              `rpm-${u.id}`,
                              () => setUserIpRules(u.id, { rpm }),
                              rpm > 0
                                ? `${u.email} is capped at ${rpm} requests/min per address.`
                                : `${u.email} is back on the workspace default.`,
                            )
                          }
                        />
                      )}
                    </td>
                    <td className="num">{num(u.known_ips || 0)}</td>
                    <td className="num">{num(u.requests_30d || 0)}</td>
                    <td>
                      <div className="acts">
                        <Button
                          size="sm"
                          variant={u.ip_limit_exempt ? "danger" : "ghost"}
                          onClick={() =>
                            run(
                              `toggle-${u.id}`,
                              () => setUserIpRules(u.id, { exempt: !u.ip_limit_exempt }),
                              u.ip_limit_exempt
                                ? `${u.email} is subject to IP limits again.`
                                : `${u.email} is no longer limited.`,
                            )
                          }
                        >
                          {u.ip_limit_exempt ? "Apply limits again" : "Never limit"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ============================== 3. always-allow / always-refuse lists === */}
      <div className="adm-card">
        <h3>Address lists</h3>
        <p className="sub">
          The always-allow list wins over everything, including a ban — put your own office,
          server and CI addresses here so a mistake below can never lock you out. The refuse
          list is checked next, before any per-key rule.
        </p>

        <div className="adm-grid two">
          <div>
            <L hint="IP or CIDR">Never limited</L>
            <div className="acts">
              <input
                className="adm-input"
                placeholder="203.0.113.7 or 2001:db8::/48"
                value={newExempt}
                onChange={(e) => setNewExempt(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!newExempt.trim() || busy === "exempt-ip"}
                onClick={() =>
                  run(
                    "exempt-ip",
                    async () => {
                      await exemptIp(newExempt.trim(), true);
                      setNewExempt("");
                    },
                    "Address added to the always-allow list.",
                  )
                }
              >
                Add
              </Button>
            </div>
            <div className="faint xs" style={{ marginTop: 8 }}>
              {(form.ip_exempt_ips || []).length === 0 ? (
                "Nothing exempt yet."
              ) : (
                <div className="acts" style={{ flexWrap: "wrap" }}>
                  {(form.ip_exempt_ips || []).map((ip) => (
                    <Button
                      key={ip}
                      size="sm"
                      variant="ghost"
                      title="Remove from the always-allow list"
                      onClick={() =>
                        run("exempt-ip", () => exemptIp(ip, false), `${ip} is no longer exempt.`)
                      }
                    >
                      {ip} ×
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <L hint="one per line">Always refused</L>
            <textarea
              className="adm-textarea"
              rows={4}
              defaultValue={(form.ip_denylist || []).join("\n")}
              onBlur={(e) => {
                const next = asList(e.target.value);
                const prev = form.ip_denylist || [];
                if (next.join(",") !== prev.join(",")) {
                  savePatch({ ip_denylist: next }, "Refuse list saved.");
                }
              }}
            />
            <span className="faint xs">
              Saved when you click away. Unlike a ban these never expire.
            </span>
          </div>
        </div>
      </div>

      {/* ===================================== 4. what the gateway recorded === */}
      <div className="adm-card">
        <h3>Recorded addresses</h3>
        <p className="sub">
          Straight out of <code>ip_registry</code>. This survives log retention, so the history
          stays even after request logs are pruned.
        </p>

        <form
          className="adm-grid two"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(new FormData(e.currentTarget).get("q") || "");
          }}
        >
          <div>
            <L>Window</L>
            <select
              className="adm-select"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            >
              {WINDOWS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <L>Address or email</L>
            <div className="acts">
              <input className="adm-input" name="q" defaultValue={search} placeholder="198.51.100 or someone@gmail.com" />
              <Button type="submit" size="sm" variant="ghost">
                Search
              </Button>
            </div>
          </div>
        </form>

        {rows.length === 0 ? (
          <div className="adm-empty">
            <b>No addresses recorded in this window</b>
            A caller address appears here the first time a request reaches the gateway with a
            valid key.
          </div>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Account</th>
                  <th className="num">Req</th>
                  <th className="num">Refused</th>
                  <th className="num">This min</th>
                  <th className="num">This hr</th>
                  <th className="num">Accts</th>
                  <th>Last seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.ip}-${r.user_id}`}>
                    <td>
                      <b className="mono">{r.ip}</b>
                      <div className="acts" style={{ marginTop: 4 }}>
                        {r.blocked ? <span className="st st-suspended">banned</span> : null}
                        {r.exempt_ip ? <span className="st st-working">exempt IP</span> : null}
                        {r.account_exempt ? (
                          <span className="st st-disabled">account exempt</span>
                        ) : null}
                        {r.note ? <span className="faint xs">{r.note}</span> : null}
                      </div>
                    </td>
                    <td>
                      <span className="xs">{r.email || "—"}</span>
                      <div className="faint xs">
                        {r.account_rpm > 0 ? `own cap ${r.account_rpm}/min` : "workspace default"}
                      </div>
                    </td>
                    <td className="num">{num(r.requests || 0)}</td>
                    <td className="num">{num(r.refused || 0)}</td>
                    <td className="num">{num(r.minute_hits || 0)}</td>
                    <td className="num">{num(r.hour_hits || 0)}</td>
                    <td className="num">{num(r.accounts_on_ip || 0)}</td>
                    <td className="faint xs" title={dateTime(r.last_seen_at)}>
                      {relative(r.last_seen_at)}
                      <div>first {relative(r.first_seen_at)}</div>
                    </td>
                    <td className="acts">
                      {r.blocked ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => run(`ip-${r.ip}`, () => unblockIp(r.ip), `${r.ip} unbanned.`)}
                        >
                          Unban
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              run(
                                `ip-${r.ip}`,
                                () => blockIp(r.ip, "banned from the admin panel", 60),
                                `${r.ip} banned for an hour.`,
                              )
                            }
                          >
                            Ban 1h
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() =>
                              run(
                                `ip-${r.ip}`,
                                () => blockIp(r.ip, "banned from the admin panel", null),
                                `${r.ip} banned.`,
                              )
                            }
                          >
                            Ban
                          </Button>
                        </>
                      )}
                      {r.exempt_ip ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            run(`ip-${r.ip}`, () => exemptIp(r.ip, true), `${r.ip} is never limited.`)
                          }
                        >
                          Exempt
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Remove this address from the record"
                        onClick={() => {
                          if (!window.confirm(`Forget ${r.ip} for ${r.email || "this account"}?`)) return;
                          run(`ip-${r.ip}`, () => forgetIp(r.ip, r.user_id), "Address forgotten.");
                        }}
                      >
                        Forget
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* =============================================== 5. the ban list === */}
      <div className="adm-card">
        <h3>Banned addresses</h3>
        <p className="sub">
          Manual bans and anything the auto-ban rule caught. A ban beats every rule except the
          always-allow list above.
        </p>

        <div className="adm-grid">
          <div>
            <L hint="IP or CIDR">Address</L>
            <input
              className="adm-input"
              placeholder="198.51.100.23 or 198.51.100.0/24"
              value={newBan.cidr}
              onChange={(e) => setNewBan((b) => ({ ...b, cidr: e.target.value }))}
            />
          </div>
          <div>
            <L>Reason</L>
            <input
              className="adm-input"
              placeholder="scraping"
              value={newBan.reason}
              onChange={(e) => setNewBan((b) => ({ ...b, reason: e.target.value }))}
            />
          </div>
          <div>
            <L hint="blank = forever">Minutes</L>
            <input
              className="adm-input"
              type="number"
              min="0"
              placeholder="1440"
              value={newBan.minutes}
              onChange={(e) => setNewBan((b) => ({ ...b, minutes: e.target.value }))}
            />
          </div>
        </div>
        <div className="adm-form-actions">
          <Button
            size="sm"
            variant="danger"
            disabled={!newBan.cidr.trim() || busy === "ban"}
            onClick={() =>
              run(
                "ban",
                async () => {
                  await blockIp(
                    newBan.cidr.trim(),
                    newBan.reason.trim() || null,
                    Number(newBan.minutes) || null,
                  );
                  setNewBan({ cidr: "", reason: "", minutes: "" });
                },
                "Address banned.",
              )
            }
          >
            Ban address
          </Button>
        </div>

        {bans.length === 0 ? (
          <div className="adm-empty">
            <b>Nothing is banned</b>
            Ban an address here, or set an auto-ban window above and let a flood ban itself.
          </div>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Range</th>
                  <th>Reason</th>
                  <th>Source</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bans.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.ip_range}</td>
                    <td className="xs">{b.reason || "—"}</td>
                    <td>
                      <span className={`st st-${b.source === "auto" ? "rate_limited" : "suspended"}`}>
                        {b.source}
                      </span>
                    </td>
                    <td className="faint xs">
                      {b.expires_at ? relative(b.expires_at) : "never"}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          run(`unban-${b.id}`, () => unblockIp(b.ip_range), "Ban lifted.")
                        }
                      >
                        Lift
                      </Button>
                    </td>
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

/* One row's "own ceiling" box. Kept as its own component so each row owns its
   draft value instead of the tab juggling a map of pending edits. */
function RpmCell({ user, onSave, busy }) {
  const [value, setValue] = React.useState(String(user.ip_rate_limit_rpm ?? 0));
  const dirty = Number(value || 0) !== Number(user.ip_rate_limit_rpm ?? 0);

  return (
    <div className="acts">
      <input
        className="adm-input"
        type="number"
        min="0"
        style={{ maxWidth: 110 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        title="Requests per minute per address. 0 inherits the workspace default."
      />
      <Button
        size="sm"
        variant={dirty ? "primary" : "ghost"}
        disabled={!dirty || busy}
        onClick={() => onSave(Math.max(0, Number(value) || 0))}
      >
        {busy ? "Saving" : "Set"}
      </Button>
    </div>
  );
}
