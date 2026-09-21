/* ==========================================================================
   Announcements tab — the operator's write path for the site banner (v12.7)
   --------------------------------------------------------------------------
   Active rows render under the site header on every public page, signed in or
   not. Every write goes through the admin_*_announcement RPCs, so each change
   lands in the audit trail; there is no table-level write policy to bypass.
   ========================================================================== */

import React, { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Field,
  TextInput,
} from "../../components/ui/index.jsx";
import {
  adminCreateAnnouncement,
  adminDeleteAnnouncement,
  adminListAnnouncements,
  adminUpdateAnnouncement,
} from "../../lib/db.js";
import { dateTime } from "../../lib/format.js";
import { Empty, Panel, SelectField } from "./parts.jsx";

const TONES = [
  { id: "info", label: "Info" },
  { id: "ok", label: "Good news" },
  { id: "warn", label: "Warning" },
];

const EMPTY_DRAFT = { title: "", body: "", tone: "info", is_active: true };

export default function AnnouncementsTab() {
  const [rows, setRows] = useState(null); // null = still loading
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = async () => {
    try {
      setRows(await adminListAnnouncements());
    } catch (err) {
      /* the not-installed error names the exact v12.7 upgrade file */
      setNote({ tone: "error", text: err.message || "Could not load announcements." });
      setRows([]);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await adminCreateAnnouncement(draft);
      setDraft(EMPTY_DRAFT);
      setNote({ tone: "ok", text: "Announcement published." });
      await load();
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not publish." });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row) => {
    setNote(null);
    try {
      await adminUpdateAnnouncement(row.id, { is_active: !row.is_active });
      await load();
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not update." });
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.title}"? This cannot be undone.`)) return;
    setNote(null);
    try {
      await adminDeleteAnnouncement(row.id);
      await load();
    } catch (err) {
      setNote({ tone: "error", text: err.message || "Could not delete." });
    }
  };

  return (
    <>
      {note ? (
        <Alert tone={note.tone} title={note.tone === "ok" ? "Done" : "Problem"}>
          {note.text}
        </Alert>
      ) : null}

      <Panel title="New announcement" sub="shows under the site header on every public page">
        <form onSubmit={create}>
          <Field label="Title" htmlFor="ann-title">
            <TextInput
              id="ann-title"
              placeholder="We are migrating regions on Saturday"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field
            label="Body"
            htmlFor="ann-body"
            optional
            hint="One or two sentences. Angle brackets are stripped server-side."
          >
            <textarea
              id="ann-body"
              className="input"
              rows={3}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
          <div className="adm-grid two">
            <SelectField
              label="Tone"
              value={draft.tone}
              onChange={(v) => setDraft({ ...draft, tone: v })}
              options={TONES}
            />
            <Checkbox
              id="ann-active"
              checked={draft.is_active}
              onChange={(v) => setDraft({ ...draft, is_active: v })}
            >
              Visible immediately
            </Checkbox>
          </div>
          <div className="adm-form-actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!draft.title.trim()}
            >
              Publish announcement
            </Button>
          </div>
        </form>
      </Panel>

      <Panel
        title="On the site"
        sub={rows ? `${rows.length} total` : "loading…"}
      >
        {rows === null ? null : rows.length === 0 ? (
          <Empty>
            No announcements yet. The first one you publish appears on every
            public page.
          </Empty>
        ) : (
          <div className="ann-adm-list">
            {rows.map((row) => (
              <div
                key={row.id}
                className={`ann-adm-row is-${row.is_active ? "on" : "off"}`}
              >
                <div className="ann-adm-main">
                  <b>{row.title}</b>
                  {row.body ? <p>{row.body}</p> : null}
                  <span className="ann-adm-meta">
                    {row.tone} · {row.is_active ? "visible" : "hidden"} ·{" "}
                    {dateTime(row.created_at)}
                  </span>
                </div>
                <div className="ann-adm-actions">
                  <Button size="sm" variant="ghost" onClick={() => toggle(row)}>
                    {row.is_active ? "Hide" : "Show"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(row)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
