/* ==========================================================================
   InboxTab — the admin end of the member lane
   --------------------------------------------------------------------------
   Members can now open a private thread from the community portal. This is
   where those threads arrive: a list on the left, the conversation on the
   right, a reply box underneath, and a status you can move (open → answered
   → closed) so a shared inbox does not turn into a guessing game.

   Everything reads through the views and RPCs added by
   supabase/upgrade-v12.1-admin-messages.sql. Until that file is applied the
   list simply comes back empty and says so — nothing throws.

   RULES OF HOOKS: every hook is in one block at the top, before any return.
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Spinner } from "../../components/ui/index.jsx";
import { initials } from "../../lib/auth.js";
import { relative } from "../../lib/format.js";
import {
  ADMIN_DM_HINT,
  deleteAdminMessage,
  listAdminMessages,
  listAdminThreads,
  markAdminThreadRead,
  replyAdminThread,
  setAdminThreadStatus,
} from "../../lib/db.js";

const POLL_MS = 6000;

const VIEWS = [
  { id: "unread", label: "Unread" },
  { id: "open", label: "Open" },
  { id: "all", label: "All" },
  { id: "closed", label: "Closed" },
];

const STATUS_LABEL = {
  open: "open",
  answered: "answered",
  closed: "closed",
};

export default function InboxTab({ onSync }) {
  const [threads, setThreads] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [view, setView] = useState("unread");
  const [q, setQ] = useState("");
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef(null);
  const activeRef = useRef("");
  const syncRef = useRef(onSync);

  /* the rail badge lives in Admin.jsx — hand it every list we load without
     making the poller depend on the callback identity */
  useEffect(() => {
    syncRef.current = onSync;
  }, [onSync]);

  const loadThreads = useCallback(async () => {
    try {
      const rows = await listAdminThreads();
      setThreads(rows || []);
      if (syncRef.current) syncRef.current(rows || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadMessages = useCallback(async (id) => {
    if (!id) return;
    try {
      const rows = await listAdminMessages(id);
      if (activeRef.current !== id) return; // switched threads mid-flight
      setMessages(rows || []);
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    loadThreads();
    const id = window.setInterval(loadThreads, POLL_MS);
    return () => window.clearInterval(id);
  }, [loadThreads]);

  useEffect(() => {
    activeRef.current = activeId;
    if (!activeId) {
      setMessages([]);
      return undefined;
    }
    setLoadingMsgs(true);
    loadMessages(activeId).finally(() => setLoadingMsgs(false));
    /* opening a thread is reading it */
    markAdminThreadRead(activeId)
      .then(loadThreads)
      .catch(() => {});
    const id = window.setInterval(() => loadMessages(activeId), POLL_MS);
    return () => window.clearInterval(id);
  }, [activeId, loadMessages, loadThreads]);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (threads || []).filter((t) => {
      if (view === "unread" && !(Number(t.unread) > 0)) return false;
      if (view === "open" && t.status === "closed") return false;
      if (view === "closed" && t.status !== "closed") return false;
      if (!needle) return true;
      return [t.member_name, t.member_email, t.subject, t.last_body]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [threads, view, q]);

  const active = useMemo(
    () => (threads || []).find((t) => t.id === activeId) || null,
    [threads, activeId],
  );

  /* =======================================================================
     HANDLERS — no hooks past this point
     ======================================================================= */
  async function send() {
    const body = reply.trim();
    if (!body || sending || !active) return;
    setSending(true);
    setError("");
    try {
      await replyAdminThread(active.id, body);
      setReply("");
      await loadMessages(active.id);
      await loadThreads();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSending(false);
    }
  }

  async function move(status) {
    if (!active) return;
    try {
      await setAdminThreadStatus(active.id, status);
      await loadThreads();
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function remove(id) {
    try {
      await deleteAdminMessage(id);
      await loadMessages(activeId);
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <div className="adm-head">
        <div>
          <h3>Messages</h3>
          <p className="ad-sub">
            Private threads members opened from the community portal. Replies
            land back in their portal straight away.
          </p>
        </div>
      </div>

      {error ? (
        <Alert tone="error" title="Inbox">
          {error}
        </Alert>
      ) : null}

      <div className="ad-inbox">
        <aside className="ad-inbox-list">
          <div className="ad-inbox-list-head">
            <b>Threads</b>
            <span className="ad-inbox-count">{shown.length}</span>
          </div>

          <div className="ad-inbox-filters">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`ad-pill ${view === v.id ? "is-on" : ""}`}
                aria-pressed={view === v.id}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <input
            className="adm-input ad-inbox-search"
            placeholder="Search name, email, subject…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          <div className="ad-threads">
            {loadingList ? (
              <div className="ad-inbox-empty">
                <Spinner /> Loading threads…
              </div>
            ) : shown.length === 0 ? (
              <div className="ad-inbox-empty">
                <b>Nothing here</b>
                <span>
                  {threads.length === 0
                    ? ADMIN_DM_HINT
                    : "No thread matches this filter."}
                </span>
              </div>
            ) : (
              shown.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`ad-thread ${t.id === activeId ? "is-active" : ""}`}
                  onClick={() => setActiveId(t.id)}
                >
                  <span className="ad-thread-top">
                    <span className="ad-thread-name">
                      {t.member_name || t.member_email || "member"}
                    </span>
                    <span className="ad-thread-time">
                      {relative(t.last_message_at)}
                    </span>
                  </span>
                  <span className="ad-thread-preview">
                    {t.last_body || t.subject || "—"}
                  </span>
                  <span className="ad-thread-meta">
                    <span className={`ad-status is-${t.status || "open"}`}>
                      {STATUS_LABEL[t.status] || "open"}
                    </span>
                    <span>{t.messages || 0} msg</span>
                    {Number(t.unread) > 0 ? (
                      <span className="ad-unread">{t.unread} new</span>
                    ) : null}
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="ad-inbox-main">
          {!active ? (
            <div className="ad-inbox-empty">
              <b>Pick a thread</b>
              <span>
                Unread threads are listed first. Nothing is sent until you hit
                reply.
              </span>
            </div>
          ) : (
            <>
              <header className="ad-inbox-head">
                <div className="ad-inbox-who">
                  <span className="ad-avatar" aria-hidden="true">
                    {initials(active.member_name || active.member_email)}
                  </span>
                  <span>
                    <b>{active.member_name || active.member_email || "member"}</b>
                    <span className="ad-inbox-sub">
                      {active.member_email}
                      {active.member_plan ? ` · ${active.member_plan}` : ""}
                      {active.subject ? ` · ${active.subject}` : ""}
                    </span>
                  </span>
                </div>
                <div className="ad-inbox-actions">
                  <span className={`ad-status is-${active.status || "open"}`}>
                    {STATUS_LABEL[active.status] || "open"}
                  </span>
                  {active.status === "closed" ? (
                    <Button size="sm" variant="ghost" onClick={() => move("open")}>
                      Reopen
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => move("closed")}
                    >
                      Close
                    </Button>
                  )}
                </div>
              </header>

              <div className="ad-stream" ref={streamRef}>
                {loadingMsgs && messages.length === 0 ? (
                  <div className="ad-inbox-empty">
                    <Spinner /> Loading…
                  </div>
                ) : messages.length === 0 ? (
                  <div className="ad-inbox-empty">
                    <b>No messages</b>
                    <span>This thread is empty.</span>
                  </div>
                ) : (
                  messages.map((m) => (
                    <article
                      key={m.id}
                      className={`ad-msg ${m.from_admin ? "is-staff" : ""}`}
                    >
                      <div className="ad-bubble">
                        <span className="ad-msg-meta">
                          <b>{m.from_admin ? "team" : m.author_name || "member"}</b>
                          <span>{relative(m.created_at)}</span>
                          <button
                            type="button"
                            className="ad-del"
                            title="Delete this message"
                            aria-label="Delete this message"
                            onClick={() => remove(m.id)}
                          >
                            ×
                          </button>
                        </span>
                        <p className="ad-msg-text">{m.body}</p>
                      </div>
                    </article>
                  ))
                )}
              </div>

              <div className="ad-composer">
                <textarea
                  className="ad-reply"
                  rows={3}
                  maxLength={4000}
                  placeholder="Reply to this member — Enter sends, Shift+Enter breaks the line"
                  value={reply}
                  disabled={sending}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={onKeyDown}
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={sending}
                  disabled={!reply.trim()}
                  onClick={send}
                >
                  Reply
                </Button>
              </div>

              <span className="ad-inbox-hint">
                The member sees replies under Direct → Admin team in the portal.
                Replying marks the thread answered.
              </span>
            </>
          )}
        </section>
      </div>
    </>
  );
}
