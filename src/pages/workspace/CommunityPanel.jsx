/* ==========================================================================
   Community portal - dashboard panel (v12.3)
   --------------------------------------------------------------------------
   A real chat client, in the dashboard: rooms, member-to-member DMs, the
   private line to the admins, replies, emoji reactions, edit, delete, day
   separators, unread markers, presence, and the daily check-in meter that
   decides whether the API gateway is answering.

   Nothing here obscures who said what. Messages carry the sender's real
   display name, DMs carry both the sender and the recipient, and bodies are
   rendered exactly as they were typed. The one thing the member-facing views
   never return is an email address - that is account data, not chat data.

   RULES OF HOOKS: every hook sits in one block at the top, before any return.
   ========================================================================== */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADMIN_DM_HINT,
  communityStanding,
  deleteAdminMessage,
  deleteChatMessage,
  deleteDmMessage,
  editChatMessage,
  editDmMessage,
  listAdminMessages,
  listChatGroups,
  listChatMessages,
  listCommunityMembers,
  listDmMessages,
  listDmThreads,
  listRoomUnread,
  markAdminThreadRead,
  markDmRead,
  markRoomRead,
  myAdminThread,
  openDmThread,
  postChatMessage,
  recordCommunityVisit,
  sendAdminMessage,
  sendDm,
  toggleChatReaction,
} from "../../lib/db.js";

/* Polling beats websockets here: one small query every four seconds keeps the
   stream live without a realtime subscription to babysit. */
const POLL_MS = 4000;

/* The admin line is not a chat_group and not a DM thread - it is the member's
   own private thread with the team, so it gets its own selection kind. */
const TEAM = "__admins";

/* How many rooms the sidebar shows before you search. The rest stay behind the
   search box, along with every other member. */
const MAIN_ROOMS = 4;

const QUICK = ["\u{1F44D}", "\u{1F525}", "\u{1F389}", "\u{1F602}", "\u{1F64F}", "\u{1F440}"];

const ONLINE_MS = 3 * 60 * 1000;
const RUN_MS = 5 * 60 * 1000;

/* ---- small helpers ------------------------------------------------------- */

function clock(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayKey(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toDateString();
}

function dayLabel(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

function ago(at) {
  const t = new Date(at).getTime();
  if (!t || Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function online(at) {
  const t = new Date(at).getTime();
  if (!t || Number.isNaN(t)) return false;
  return Date.now() - t < ONLINE_MS;
}

function mono(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function classes(...tokens) {
  return tokens.filter(Boolean).join(" ");
}

function message(e) {
  return String(e?.message || e || "Something went wrong.");
}

/* ---- one shape for three sources ---------------------------------------- */

function fromRoom(row) {
  return {
    id: row.id,
    body: row.body || "",
    at: row.created_at,
    edited: row.edited_at || null,
    mine: !!row.is_mine,
    staff: !!row.is_staff || row.author_role === "admin",
    author: row.author_name || "member",
    replyBody: row.reply_body || null,
    replyAuthor: row.reply_author || null,
    reactions: Array.isArray(row.reactions) ? row.reactions : [],
  };
}

function fromDm(row) {
  return {
    id: row.id,
    body: row.body || "",
    at: row.created_at,
    edited: row.edited_at || null,
    mine: !!row.is_mine,
    staff: !!row.is_staff,
    author: row.sender_name || "member",
    replyBody: row.reply_body || null,
    replyAuthor: row.reply_author || null,
    reactions: [],
  };
}

/* The admin line predates this upgrade, so read its shape defensively. */
function fromTeam(row) {
  const mine =
    typeof row.is_mine === "boolean"
      ? row.is_mine
      : String(row.from || row.author_role || "").toLowerCase() === "user";
  return {
    id: row.id,
    body: row.body || "",
    at: row.created_at,
    edited: row.edited_at || null,
    mine: !!mine,
    staff: !mine,
    author: row.author_name || row.sender_name || (mine ? "You" : "RageStar team"),
    replyBody: null,
    replyAuthor: null,
    reactions: [],
  };
}

/* ========================================================================== */

export default function CommunityPanel() {
  const [standing, setStanding] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [roomUnread, setRoomUnread] = useState([]);
  const [threads, setThreads] = useState([]);
  const [members, setMembers] = useState([]);
  const [team, setTeam] = useState({ ready: false, unavailable: false, hint: "", unread: 0 });
  const [sel, setSel] = useState(null);
  const [lines, setLines] = useState([]);
  const [dividerId, setDividerId] = useState(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState(null);
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState("list");

  const streamRef = useRef(null);
  const stickRef = useRef(true);
  const selRef = useRef(null);

  /* ---- loaders ---------------------------------------------------------- */

  const loadSidebar = useCallback(async () => {
    const [groups, unread, dms, people, mine] = await Promise.all([
      listChatGroups().catch(() => []),
      listRoomUnread().catch(() => []),
      listDmThreads().catch(() => []),
      listCommunityMembers().catch(() => []),
      communityStanding().catch(() => null),
    ]);

    setRooms(Array.isArray(groups) ? groups : []);
    setRoomUnread(Array.isArray(unread) ? unread : []);
    setThreads(Array.isArray(dms) ? dms : []);
    setMembers(Array.isArray(people) ? people : []);
    if (mine) setStanding(mine);

    try {
      const line = await myAdminThread();
      setTeam({
        ready: true,
        unavailable: !!line?.unavailable,
        hint: line?.hint || "",
        unread: Number(line?.thread?.unread ?? line?.unread ?? 0),
      });
    } catch (e) {
      setTeam({ ready: true, unavailable: true, hint: message(e), unread: 0 });
    }
  }, []);

  const loadStream = useCallback(async (target, fresh) => {
    if (!target) return;
    if (fresh) setBusy(true);
    try {
      let rows = [];
      if (target.kind === "room") {
        const raw = await listChatMessages(target.key, 200);
        rows = (Array.isArray(raw) ? raw : []).map(fromRoom);
      } else if (target.kind === "dm") {
        const raw = await listDmMessages(target.key, 300);
        rows = (Array.isArray(raw) ? raw : []).map(fromDm);
      } else {
        const line = await myAdminThread();
        const threadId = line?.thread?.id || null;
        const raw = threadId
          ? await listAdminMessages(threadId, 300)
          : Array.isArray(line?.messages)
            ? line.messages
            : [];
        rows = (Array.isArray(raw) ? raw : []).map(fromTeam);
      }

      setLines(rows);
      setErr("");

      if (fresh) {
        const n = Number(target.unread || 0);
        const at = rows.length - n;
        setDividerId(n > 0 && at > 0 && at < rows.length ? rows[at].id : null);
      }
    } catch (e) {
      setErr(message(e));
    } finally {
      if (fresh) setBusy(false);
    }
  }, []);

  const markRead = useCallback(async (target) => {
    if (!target) return;
    try {
      if (target.kind === "room") await markRoomRead(target.key);
      else if (target.kind === "dm") await markDmRead(target.key);
      else await markAdminThreadRead();
    } catch (e) {
      /* a read mark is never worth an error message */
    }
  }, []);

  /* ---- actions ---------------------------------------------------------- */

  const pick = useCallback((next) => {
    setSel(next);
    setPane("chat");
  }, []);

  const startDm = useCallback(
    async (person) => {
      try {
        const threadId = await openDmThread(person.id);
        pick({
          kind: "dm",
          key: threadId,
          otherId: person.id,
          name: person.name,
          role: person.role,
          lastSeen: person.last_seen_at,
          unread: 0,
        });
        await loadSidebar();
      } catch (e) {
        setErr(message(e));
      }
    },
    [loadSidebar, pick],
  );

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || !sel || sending) return;
    setSending(true);
    try {
      if (sel.kind === "room") {
        await postChatMessage(sel.key, body, reply?.id || null);
      } else if (sel.kind === "dm") {
        await sendDm(sel.otherId, body, reply?.id || null);
      } else {
        await sendAdminMessage(body);
      }
      setDraft("");
      setReply(null);
      setDividerId(null);
      stickRef.current = true;
      await loadStream(sel, false);
      await loadSidebar();
    } catch (e) {
      setErr(message(e));
    } finally {
      setSending(false);
    }
  }, [draft, sel, reply, sending, loadStream, loadSidebar]);

  const react = useCallback(
    async (line, emoji) => {
      if (!sel || sel.kind !== "room") return;
      try {
        await toggleChatReaction(line.id, emoji);
        await loadStream(sel, false);
      } catch (e) {
        setErr(message(e));
      }
    },
    [sel, loadStream],
  );

  const saveEdit = useCallback(async () => {
    if (!editing || !sel) return;
    const body = String(editing.body || "").trim();
    if (!body) return;
    try {
      if (sel.kind === "dm") await editDmMessage(editing.id, body);
      else await editChatMessage(editing.id, body);
      setEditing(null);
      await loadStream(sel, false);
    } catch (e) {
      setErr(message(e));
    }
  }, [editing, sel, loadStream]);

  const remove = useCallback(
    async (line) => {
      if (!sel) return;
      try {
        if (sel.kind === "room") await deleteChatMessage(line.id);
        else if (sel.kind === "dm") await deleteDmMessage(line.id);
        else await deleteAdminMessage(line.id);
        await loadStream(sel, false);
        await loadSidebar();
      } catch (e) {
        setErr(message(e));
      }
    },
    [sel, loadStream, loadSidebar],
  );

  const refresh = useCallback(() => {
    stickRef.current = true;
    loadSidebar().catch(() => {});
    if (sel) loadStream(sel, true).catch(() => {});
  }, [sel, loadSidebar, loadStream]);

  /* ---- effects ---------------------------------------------------------- */

  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  /* opening the portal is the daily check-in */
  useEffect(() => {
    recordCommunityVisit("portal").catch(() => {});
    let alive = true;
    loadSidebar()
      .catch((e) => {
        if (alive) setErr(message(e));
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
    };
  }, [loadSidebar]);

  /* land somewhere sensible once the rooms arrive */
  useEffect(() => {
    if (!sel && rooms.length) {
      const first = rooms.find((r) => r.slug === "general") || rooms[0];
      setSel({
        kind: "room",
        key: first.slug,
        name: first.name,
        about: first.description,
        isLocked: !!first.is_locked,
        unread: 0,
      });
    }
  }, [rooms, sel]);

  useEffect(() => {
    if (sel) {
      setLines([]);
      setReply(null);
      setEditing(null);
      setErr("");
      stickRef.current = true;
      loadStream(sel, true).catch(() => {});
      markRead(sel).catch(() => {});
    }
  }, [sel, loadStream, markRead]);

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) {
        loadSidebar().catch(() => {});
        if (selRef.current) loadStream(selRef.current, false).catch(() => {});
      }
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [loadSidebar, loadStream]);

  useEffect(() => {
    const el = streamRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /* ---- derived ---------------------------------------------------------- */

  const unreadByRoom = useMemo(() => {
    const map = {};
    roomUnread.forEach((row) => {
      map[row.slug] = Number(row.unread || 0);
    });
    return map;
  }, [roomUnread]);

  const needle = query.trim().toLowerCase();

  /* The sidebar opens on the four main rooms and nothing else. Everything
     beyond that — the rest of the rooms, and every other member — is behind the
     search box, so the list reads as a short index instead of a directory you
     have to scroll. Searching shows the full match set. */
  const activeRooms = useMemo(() => rooms.filter((r) => r.is_active !== false), [rooms]);

  const shownRooms = useMemo(() => {
    if (!needle) return activeRooms.slice(0, MAIN_ROOMS);
    return activeRooms.filter((r) =>
      (String(r.name || "") + " " + String(r.slug || "")).toLowerCase().includes(needle),
    );
  }, [activeRooms, needle]);

  const moreRooms = needle ? 0 : Math.max(0, activeRooms.length - MAIN_ROOMS);

  /* Other members' conversations are hidden until you search for one. Only the
     RageStar team line stays put — that is the private line to the admins, not
     a person in a directory. */
  const shownThreads = useMemo(() => {
    if (!needle) return [];
    return threads.filter((t) => String(t.other_name || "").toLowerCase().includes(needle));
  }, [threads, needle]);

  /* People are hidden until you search for one. Listing every member up front
     was most of the sidebar's length, and a conversation starts from a search
     anyway. */
  const shownMembers = useMemo(() => {
    if (!needle) return [];
    const known = new Set(threads.map((t) => t.other_id));
    return members
      .filter((m) => !m.is_me && !known.has(m.id))
      .filter((m) => String(m.name || "").toLowerCase().includes(needle));
  }, [members, threads, needle]);

  const iAmStaff = useMemo(
    () => members.some((m) => m.is_me && m.role === "admin"),
    [members],
  );

  const roomTotal = useMemo(
    () => Object.values(unreadByRoom).reduce((sum, n) => sum + Number(n || 0), 0),
    [unreadByRoom],
  );

  const dmTotal = useMemo(
    () => threads.reduce((sum, t) => sum + Number(t.unread || 0), 0) + Number(team.unread || 0),
    [threads, team],
  );

  /* today's standing */
  const gateOn = standing?.enabled !== false;
  const required = Number(standing?.required ?? 2);
  const sentToday = Number(standing?.sent_today ?? 0);
  const visited = standing?.visited_today !== false;
  const unlocked = !gateOn || standing?.unlocked !== false;
  const need = Math.max(0, Number(standing?.remaining ?? Math.max(0, required - sentToday)));
  const signedOut = standing?.signed_in === false;
  const meterPct = required > 0 ? Math.min(100, Math.round((sentToday / required) * 100)) : 100;
  const meterStyle = { width: meterPct + "%" };

  const locked = sel?.kind === "room" && sel.isLocked && !iAmStaff;
  const canType = !!sel && !signedOut && !locked;

  const title =
    sel?.kind === "team" ? "RageStar team" : sel?.name || (sel?.kind === "room" ? sel.key : "");

  let meta = "";
  if (sel?.kind === "room") {
    meta = sel.about || "#" + sel.key;
  } else if (sel?.kind === "dm") {
    meta = online(sel.lastSeen)
      ? "Online now"
      : sel.lastSeen
        ? "Last seen " + ago(sel.lastSeen)
        : "Direct message";
  } else if (sel?.kind === "team") {
    meta = "Private line - only you and the admins can read this";
  }

  /* ---- render ----------------------------------------------------------- */

  return (
    <div className="wk-community cmx">
      <header className="cmx-head">
        <div className="cmx-head-main">
          <span className="cmx-eyebrow">Community</span>
          <h2 className="cmx-title">Portal</h2>
          <p className="cmx-sub">
             Rooms, direct messages and the line to the team. Checking in and writing{" "}
             {required} sentence{required === 1 ? "" : "s"} a day keeps your API keys serving
             traffic.
          </p>
        </div>

        <div className="cmx-quota" data-state={unlocked ? "open" : "locked"}>
          <div className="cmx-quota-top">
            <span>Today</span>
            <span className="cmx-quota-state">
              {!gateOn ? "Rule off" : unlocked ? "Gateway unlocked" : "Gateway paused"}
            </span>
          </div>
          <div className="cmx-meter">
            <span className="cmx-meter-fill" style={meterStyle} />
          </div>
          <div className="cmx-quota-legs">
            <span className={classes("cmx-leg", visited && "is-done")}>
              <i className="cmx-leg-mark">{"\u2713"}</i> Checked in
            </span>
            <span className={classes("cmx-leg", sentToday >= required && "is-done")}>
              <i className="cmx-leg-mark">{"\u2713"}</i> {sentToday}/{required} sentences written
            </span>
          </div>
        </div>
      </header>

      <div className={classes("cmx-gate", unlocked && "is-open")}>
        <span className="cmx-gate-ico" aria-hidden="true">
          {unlocked ? "\u2713" : "\u26A0"}
        </span>
        <span className="cmx-gate-txt">
          {!gateOn ? (
            <>The daily check-in is switched off right now, so write whenever you like.</>
          ) : unlocked ? (
            <>
              <b>You are done for today.</b> Checked in, {sentToday} of {required} sentences
              written - the gateway is serving your keys.
            </>
          ) : (
            <>
              <b>Gateway paused.</b>{" "}
              {visited ? "You have checked in." : "Open a room below to check in."}{" "}
              {need > 0
                ? "Write " +
                  need +
                  " more sentence" +
                  (need === 1 ? "" : "s") +
                  " today and your API keys start working again."
                : "Write a sentence to finish today's check-in."}
            </>
          )}
        </span>
      </div>

      <div className="cmx-shell" data-pane={pane}>
        {/* ---- sidebar ---- */}
        <aside className="cmx-side">
          <div className="cmx-side-top">
            <input
              className="cmx-search"
              type="search"
              value={query}
              placeholder="Search rooms and people"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="cmx-side-scroll">
            {/* Rooms lead. They are what most visits are for, and the sidebar
                used to open on Direct instead, which pushed them below the
                fold on a short panel. */}
            <section className="cmx-sect">
              <div className="cmx-sect-head">
                <span>Rooms</span>
                {roomTotal > 0 ? <span className="cmx-badge is-quiet">{roomTotal}</span> : null}
              </div>
              <ul className="cmx-list">
                {shownRooms.map((r) => {
                  const n = Number(unreadByRoom[r.slug] || 0);
                  return (
                    <li key={r.slug}>
                      <button
                        type="button"
                        className={classes(
                          "cmx-item",
                          sel?.kind === "room" && sel.key === r.slug && "is-active",
                          n > 0 && "is-unread",
                        )}
                        onClick={() =>
                          pick({
                            kind: "room",
                            key: r.slug,
                            name: r.name,
                            about: r.description,
                            isLocked: !!r.is_locked,
                            unread: n,
                          })
                        }
                      >
                        <span className="cmx-ava is-room">
                          <span className="cmx-hash">#</span>
                        </span>
                        <span className="cmx-item-main">
                          <span className="cmx-item-name">{r.name || r.slug}</span>
                          <span className="cmx-item-last">{r.description || "#" + r.slug}</span>
                        </span>
                        {r.is_locked ? <span className="cmx-lock">{"\u{1F512}"}</span> : null}
                        {n > 0 ? <span className="cmx-badge">{n > 99 ? "99+" : n}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!shownRooms.length ? <p className="cmx-side-empty">No rooms match.</p> : null}
              {moreRooms > 0 ? (
                <p className="cmx-side-more">
                  {moreRooms} more {moreRooms === 1 ? "room" : "rooms"} — type above to search.
                </p>
              ) : null}
            </section>

            <section className="cmx-sect">
              <div className="cmx-sect-head">
                <span>Direct</span>
                {dmTotal > 0 ? <span className="cmx-badge">{dmTotal}</span> : null}
              </div>
              <ul className="cmx-list">
                {team.ready && !team.unavailable ? (
                  <li>
                    <button
                      type="button"
                      className={classes(
                        "cmx-item",
                        sel?.kind === "team" && "is-active",
                        team.unread > 0 && "is-unread",
                      )}
                      onClick={() =>
                        pick({ kind: "team", key: TEAM, name: "RageStar team", unread: team.unread })
                      }
                    >
                      <span className="cmx-ava is-staff">RS</span>
                      <span className="cmx-item-main">
                        <span className="cmx-item-name">RageStar team</span>
                        <span className="cmx-item-last">Private line to the admins</span>
                      </span>
                      {team.unread > 0 ? <span className="cmx-badge">{team.unread}</span> : null}
                    </button>
                  </li>
                ) : null}

                {shownThreads.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={classes(
                        "cmx-item",
                        sel?.kind === "dm" && sel.key === t.id && "is-active",
                        Number(t.unread || 0) > 0 && "is-unread",
                      )}
                      onClick={() =>
                        pick({
                          kind: "dm",
                          key: t.id,
                          otherId: t.other_id,
                          name: t.other_name,
                          role: t.other_role,
                          lastSeen: t.other_last_seen,
                          unread: Number(t.unread || 0),
                        })
                      }
                    >
                      <span
                        className={classes("cmx-ava", t.other_role === "admin" && "is-staff")}
                      >
                        {mono(t.other_name)}
                      </span>
                      <span className="cmx-item-main">
                        <span className="cmx-item-name">{t.other_name || "member"}</span>
                        <span className="cmx-item-last">
                          {t.last_body
                            ? (t.last_sender_name ? t.last_sender_name + ": " : "") + t.last_body
                            : "No messages yet"}
                        </span>
                      </span>
                      {Number(t.unread || 0) > 0 ? (
                        <span className="cmx-badge">{t.unread}</span>
                      ) : (
                        <span
                          className={classes("cmx-online", !online(t.other_last_seen) && "is-off")}
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {!shownThreads.length ? (
                <p className="cmx-side-empty">
                  {needle
                    ? "No conversation matches that name."
                    : "Your conversations appear when you search."}
                </p>
              ) : null}
            </section>


            <section className="cmx-sect">
              <div className="cmx-sect-head">
                <span>Members</span>
              </div>
              <ul className="cmx-list">
                {shownMembers.slice(0, 60).map((m) => (
                  <li key={m.id}>
                    <button type="button" className="cmx-item" onClick={() => startDm(m)}>
                      <span className={classes("cmx-ava", m.role === "admin" && "is-staff")}>
                        {mono(m.name)}
                      </span>
                      <span className="cmx-item-main">
                        <span className="cmx-item-name">{m.name}</span>
                        <span className="cmx-item-last">
                          {m.online
                            ? "Online now"
                            : m.last_seen_at
                              ? "Last seen " + ago(m.last_seen_at)
                              : "Away"}
                        </span>
                      </span>
                      <span className={classes("cmx-online", !m.online && "is-off")} />
                    </button>
                  </li>
                ))}
              </ul>
              {!needle ? (
                <p className="cmx-side-empty">Search a name above to find someone to message.</p>
              ) : !shownMembers.length ? (
                <p className="cmx-side-empty">No other member matches that name.</p>
              ) : null}
            </section>
          </div>
        </aside>

        {/* ---- conversation ---- */}
        <section className="cmx-main">
          <header className="cmx-bar">
            <button
              type="button"
              className="cmx-back"
              title="Back to the list"
              onClick={() => setPane("list")}
            >
              {"\u2190"}
            </button>
            <div className="cmx-bar-main">
              <div className="cmx-bar-name">
                {sel?.kind === "room" ? <span className="cmx-hash">#</span> : null}
                <span>{title || "Community"}</span>
                {sel?.kind === "team" || sel?.role === "admin" ? (
                  <span className="cmx-tag is-admin">team</span>
                ) : null}
              </div>
              <span className="cmx-bar-meta">{meta}</span>
            </div>
            <div className="cmx-bar-actions">
              {locked ? (
                <span className="cmx-pill is-lock">Announcements</span>
              ) : (
                <span className="cmx-pill is-live">Live</span>
              )}
              <button type="button" className="cmx-ico-btn" title="Refresh" onClick={refresh}>
                {"\u21BB"}
              </button>
            </div>
          </header>

          <div
            className="cmx-stream"
            ref={streamRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
            }}
          >
            {booting || (busy && !lines.length) ? (
              /* Dots rather than a sentence. There is no presence backend to
                 read (record_community_visit only stamps last_seen), so this
                 states what is actually happening — the room is fetching —
                 instead of naming somebody as typing. */
              <div className="cmx-load">
                <span
                  className="cmx-typing"
                  role="status"
                  aria-label="Loading this room's messages"
                >
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            ) : null}

            {!booting && !busy && !lines.length ? (
              <p className="cmx-empty">
                {sel?.kind === "team"
                  ? team.hint || ADMIN_DM_HINT
                  : "Nothing here yet. Say hello - it counts towards today's check-in."}
              </p>
            ) : null}

            {lines.map((line, i) => {
              const prev = i > 0 ? lines[i - 1] : null;
              const newDay = !prev || dayKey(prev.at) !== dayKey(line.at);
              const run =
                !newDay &&
                !!prev &&
                prev.author === line.author &&
                prev.mine === line.mine &&
                new Date(line.at).getTime() - new Date(prev.at).getTime() < RUN_MS;
              const isEditing = editing?.id === line.id;

              return (
                <React.Fragment key={line.id}>
                  {newDay ? <div className="cmx-day">{dayLabel(line.at)}</div> : null}
                  {dividerId && dividerId === line.id ? (
                    <div className="cmx-newline">New</div>
                  ) : null}

                  <article
                    className={classes(
                      "cmx-msg",
                      run && "is-run",
                      line.mine && "is-mine",
                      line.staff && !line.mine && "is-staff",
                    )}
                  >
                    <div className="cmx-bubble">
                      {!run || line.replyBody ? (
                        <div className="cmx-msg-top">
                          <span className="cmx-msg-author">
                            {line.mine ? "You" : line.author}
                          </span>
                          {line.staff && !line.mine ? (
                            <span className="cmx-tag is-admin">team</span>
                          ) : null}
                          {line.mine ? <span className="cmx-tag is-you">you</span> : null}
                          <span className="cmx-time">{clock(line.at)}</span>
                          {line.edited ? <span className="cmx-edited">edited</span> : null}
                        </div>
                      ) : null}

                      {line.replyBody ? (
                        <span className="cmx-quote">
                          <b>{line.replyAuthor || "member"}</b> {line.replyBody}
                        </span>
                      ) : null}

                      {isEditing ? (
                        <div className="cmx-editrow">
                          <textarea
                            className="cmx-edit-input"
                            value={editing.body}
                            onChange={(e) => setEditing({ id: line.id, body: e.target.value })}
                          />
                          <div className="cmx-edit-actions">
                            <button
                              type="button"
                              className="cmx-mini"
                              onClick={() => setEditing(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="cmx-mini is-primary"
                              onClick={saveEdit}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="cmx-text">{line.body}</p>
                      )}

                      {line.reactions.length ? (
                        <div className="cmx-reacts">
                          {line.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              type="button"
                              className={classes("cmx-react", r.mine && "is-mine")}
                              onClick={() => react(line, r.emoji)}
                            >
                              <span>{r.emoji}</span>
                              <span>{r.count}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="cmx-tools">
                      {sel?.kind !== "team" ? (
                        <button
                          type="button"
                          className="cmx-tool"
                          title="Reply"
                          onClick={() =>
                            setReply({
                              id: line.id,
                              author: line.mine ? "your message" : line.author,
                              body: line.body,
                            })
                          }
                        >
                          {"\u21A9"}
                        </button>
                      ) : null}
                      {sel?.kind === "room" ? (
                        <button
                          type="button"
                          className="cmx-tool"
                          title="React"
                          onClick={() => react(line, QUICK[0])}
                        >
                          {QUICK[0]}
                        </button>
                      ) : null}
                      {line.mine && sel?.kind !== "team" ? (
                        <button
                          type="button"
                          className="cmx-tool"
                          title="Edit"
                          onClick={() => setEditing({ id: line.id, body: line.body })}
                        >
                          {"\u270E"}
                        </button>
                      ) : null}
                      {line.mine || iAmStaff ? (
                        <button
                          type="button"
                          className="cmx-tool is-stop"
                          title="Delete"
                          onClick={() => remove(line)}
                        >
                          {"\u2715"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                </React.Fragment>
              );
            })}
          </div>

          {err ? <div className="cmx-error">{err}</div> : null}

          {reply ? (
            <div className="cmx-replybar">
              <span className="cmx-replybar-txt">
                Replying to <b>{reply.author}</b> - {reply.body}
              </span>
              <button
                type="button"
                className="cmx-replybar-x"
                title="Cancel the reply"
                onClick={() => setReply(null)}
              >
                {"\u2715"}
              </button>
            </div>
          ) : null}

          {signedOut ? (
            <p className="cmx-locked">Sign in to read and post in the community portal.</p>
          ) : locked ? (
            <p className="cmx-locked">
              This room is announcements only. Post in another room, or message the team.
            </p>
          ) : (
            <>
              <div className="cmx-composer">
                <textarea
                  className="cmx-input"
                  value={draft}
                  disabled={!canType || sending}
                  placeholder={
                    sel?.kind === "dm"
                      ? "Message " + (sel.name || "member")
                      : sel?.kind === "team"
                        ? "Message the RageStar team"
                        : "Message #" + (sel?.key || "general")
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="cmx-composer-side">
                  <div className="cmx-emoji-row">
                    {QUICK.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="cmx-emoji"
                        title={"Add " + emoji}
                        onClick={() => setDraft((prev) => prev + emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                  {sending ? (
                    <span
                      className="cmx-typing is-mini"
                      role="status"
                      aria-label="Sending your message"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="cmx-send"
                    disabled={!canType || sending || !draft.trim()}
                    onClick={send}
                  >
                    {sending ? "Sending" : "Send"}
                  </button>
                </div>
              </div>
              <p className="cmx-hint">
                Enter sends, Shift+Enter starts a new line.{" "}
                {gateOn && !unlocked && need > 0
                  ? need +
                    " more sentence" +
                    (need === 1 ? "" : "s") +
                    " today unlocks the gateway."
                  : "Every sentence counts, whichever room you write it in."}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
