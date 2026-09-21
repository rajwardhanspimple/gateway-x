import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Spinner } from "../components/ui/index.jsx";
import { useSession, initials } from "../lib/auth.js";
import { relative } from "../lib/format.js";
import {
  listChatGroups,
  listChatMessages,
  postChatMessage,
  deleteChatMessage,
} from "../lib/db.js";

/* ============================================================================
   Community
   ----------------------------------------------------------------------------
   One shared space where every signed-in member and the team can talk, split
   into rooms (General, Developers, Vibecoders, …). Rooms and the read model
   come from chat_groups / chat_feed; posting and deleting go through the
   SECURITY DEFINER RPCs in supabase/upgrade-v11.4-community-and-kie.sql, so the
   "who may post where" rules live in the database, not here.

   The feed hands back an author's display name and role badge only — never an
   email — so rendering a message can never leak a member's address. A short
   poll keeps the room live without a websocket.
============================================================================ */

const POLL_MS = 4000;

export default function Community() {
  const { isAdmin } = useSession();

  const [groups, setGroups] = useState([]);
  const [slug, setSlug] = useState("");
  const [messages, setMessages] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  const streamRef = useRef(null);
  const slugRef = useRef("");
  const atBottomRef = useRef(true);

  const activeGroup = useMemo(
    () => groups.find((g) => g.slug === slug) || null,
    [groups, slug],
  );
  const canPost = Boolean(activeGroup && (!activeGroup.is_locked || isAdmin));

  /* rooms load once */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const gs = await listChatGroups();
        if (!alive) return;
        setGroups(gs);
        const preferred = gs.find((g) => g.slug === "general") || gs[0];
        setSlug(preferred ? preferred.slug : "");
      } catch (e) {
        if (alive) setError(e.message || String(e));
      } finally {
        if (alive) setLoadingGroups(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async (target) => {
    const s = target || slugRef.current;
    if (!s) return;
    try {
      const rows = await listChatMessages(s);
      if (slugRef.current !== s) return; // switched rooms mid-flight
      setMessages(rows);
      setError("");
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  /* load + poll the active room */
  useEffect(() => {
    slugRef.current = slug;
    if (!slug) return undefined;
    setLoadingMsgs(true);
    setMessages([]);
    atBottomRef.current = true;
    refresh(slug).finally(() => setLoadingMsgs(false));
    const id = window.setInterval(() => refresh(slug), POLL_MS);
    return () => window.clearInterval(id);
  }, [slug, refresh]);

  /* keep the view pinned to the newest message unless the reader scrolled up */
  useEffect(() => {
    const el = streamRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  async function send() {
    const body = text.trim();
    if (!body || posting || !canPost) return;
    setPosting(true);
    setError("");
    try {
      await postChatMessage(slug, body);
      setText("");
      atBottomRef.current = true;
      await refresh(slug);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setPosting(false);
    }
  }

  async function remove(id) {
    try {
      await deleteChatMessage(id);
      setMessages((m) => m.filter((x) => x.id !== id));
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <main id="main" className="cm-wrap">
      <div className="cm-head">
        <h1>Community</h1>
        <p className="cm-sub">
          Talk with other builders and the RageStar team. Pick a room and say hi.
        </p>
      </div>

      <div className="cm-shell">
        <aside className="cm-rooms" aria-label="Groups">
          {loadingGroups ? (
            <div className="cm-rooms-load">
              <Spinner /> Loading rooms…
            </div>
          ) : (
            <ul>
              {groups.map((g) => (
                <li key={g.slug}>
                  <button
                    type="button"
                    className={`cm-room${g.slug === slug ? " is-active" : ""}`}
                    onClick={() => setSlug(g.slug)}
                  >
                    <span className="cm-room-name">
                      <span className="cm-hash" aria-hidden="true">#</span> {g.name}
                      {g.is_locked ? (
                        <span className="cm-lock" title="Only admins can post here">
                          🔒
                        </span>
                      ) : null}
                    </span>
                    {g.description ? (
                      <span className="cm-room-desc">{g.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section
          className="cm-main"
          aria-label={activeGroup ? activeGroup.name : "Messages"}
        >
          <header className="cm-main-head">
            <div className="cm-main-title">
              <b>
                <span className="cm-hash" aria-hidden="true">#</span>{" "}
                {activeGroup?.name || "…"}
              </b>
              {activeGroup?.is_locked ? (
                <span className="cm-tag">announcements</span>
              ) : null}
            </div>
            {activeGroup?.description ? (
              <span className="cm-muted">{activeGroup.description}</span>
            ) : null}
          </header>

          <div className="cm-stream" ref={streamRef} onScroll={onScroll}>
            {loadingMsgs ? (
              <div className="cm-empty">
                <Spinner /> Loading messages…
              </div>
            ) : messages.length === 0 ? (
              <div className="cm-empty">No messages yet — be the first to post.</div>
            ) : (
              messages.map((m) => (
                <article
                  key={m.id}
                  className={`cm-msg${m.is_mine ? " is-mine" : ""}`}
                >
                  <span className="cm-avatar" aria-hidden="true">
                    {initials(m.author_name)}
                  </span>
                  <div className="cm-body">
                    <div className="cm-meta">
                      <b className="cm-author">{m.author_name}</b>
                      {m.author_role === "admin" ? (
                        <span className="cm-badge">Admin</span>
                      ) : null}
                      <time
                        className="cm-time"
                        dateTime={m.created_at}
                        title={new Date(m.created_at).toLocaleString()}
                      >
                        {relative(m.created_at)}
                      </time>
                      {m.is_mine || isAdmin ? (
                        <button
                          type="button"
                          className="cm-del"
                          title="Delete message"
                          aria-label="Delete message"
                          onClick={() => remove(m.id)}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                    <p className="cm-text">{m.body}</p>
                  </div>
                </article>
              ))
            )}
          </div>

          {error ? (
            <div className="cm-error">
              <Alert tone="error">{error}</Alert>
            </div>
          ) : null}

          <div className="cm-composer">
            {canPost ? (
              <>
                <textarea
                  className="cm-input"
                  rows={2}
                  placeholder={`Message #${activeGroup?.name || ""}`}
                  value={text}
                  maxLength={4000}
                  disabled={posting || !slug}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                />
                <Button
                  onClick={send}
                  loading={posting}
                  disabled={!text.trim() || !slug}
                >
                  Send
                </Button>
              </>
            ) : (
              <div className="cm-locked">
                🔒 Only admins can post in {activeGroup?.name || "this room"}.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
