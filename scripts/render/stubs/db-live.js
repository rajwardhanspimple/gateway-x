/* stub — render test only, never bundled.
   A hand-written stand-in for src/lib/db.js used by the discord-live check.

   It exists for one reason: the v12.9 gate flag (app_settings.discord_required)
   lives behind getSettings(), and the real module needs a configured backend to
   answer. Scenarios flip it through globalThis.__GATE__ so the "API access is
   paused" path can be exercised in both directions.

   Only the names the settings screen's render path actually reaches are here.
   If a module starts importing something else from lib/db.js, the dynamic
   import fails loudly and the name gets added — a stub that silently returned
   undefined would hide the breakage instead. */

const gate = () => globalThis.__GATE__ || {};

export async function getSettings() {
  return {
    discord_required: gate().required === true,
    discord_join_credit_usd: gate().credit ?? 0,
  };
}

export async function listAnnouncements() {
  return [];
}

/* playground.jsx imports this at module scope; it is only called on submit, so
   an empty generator is enough to keep the import graph intact. */
export async function* streamGateway() {}

export async function getKeywatchStatus() {
  return null;
}

export async function saveKeywatchSettings() {}

export async function pingKeywatchFn() {
  return null;
}

export const KEYWATCH_UPGRADE_FILE = "supabase/upgrade-v11.3-keywatch-in-postgres.sql";

/* ------------------------------------------------------------------ community

   CommunityPanel is imported at module scope by the dashboard (it is the
   Community view now), so its whole import list has to resolve even for a
   scenario that never opens it. These are inert stand-ins: the Settings screen
   this suite mounts does not render the community, it only has to load.
   Node fails the whole module graph on a single missing name, which is how
   this list came to be — keep it in step with CommunityPanel's imports. */

export const ADMIN_DM_HINT = "The team thread needs the community tables.";

export async function communityStanding() {
  return { unavailable: true };
}
export async function recordCommunityVisit() {}
export async function listCommunityMembers() {
  return [];
}
export async function listChatGroups() {
  return [];
}
export async function listChatMessages() {
  return [];
}
export async function postChatMessage() {
  return null;
}
export async function editChatMessage() {}
export async function deleteChatMessage() {}
export async function toggleChatReaction() {}
export async function listRoomUnread() {
  return [];
}
export async function markRoomRead() {}
export async function listDmThreads() {
  return [];
}
export async function listDmMessages() {
  return [];
}
export async function openDmThread() {
  return null;
}
export async function sendDm() {
  return null;
}
export async function editDmMessage() {}
export async function deleteDmMessage() {}
export async function markDmRead() {}
export async function myAdminThread() {
  return null;
}
export async function listAdminMessages() {
  return [];
}
export async function sendAdminMessage() {
  return null;
}
export async function deleteAdminMessage() {}
export async function markAdminThreadRead() {}
