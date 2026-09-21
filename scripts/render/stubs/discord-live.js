/* stub — render test only, never bundled.
   Stands in for src/lib/discord.js so the Discord panel can be driven through
   every state without a live Discord application: linked / not linked, in the
   server / not in the server, gate on / off, and a connect that succeeds, fails,
   or is never started.

   Scenarios set globalThis.__DISCORD__ before mounting. */

const state = () => globalThis.__DISCORD__ || {};

export const DISCORD_INVITE_URL = "https://discord.gg/render-test";

export function takeDiscordResult() {
  return state().result ?? null;
}

export async function myDiscordIdentity() {
  return {
    identity: state().identity ?? null,
    unavailable: state().unavailable === true,
  };
}

export async function myDiscordJoinGrant() {
  return state().grant ?? null;
}

/* The real one is a full-page redirect; here it just records that it was
   called, so the test can prove the button is wired to it. */
export async function beginDiscordConnect() {
  state().onConnect?.();
}

export async function disconnectDiscord() {
  if (state().disconnectFails) throw new Error("network down");
  state().onDisconnect?.();
}

export function discordAvatarUrl(discordId, avatar) {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png`;
}

export function pendingDiscordCallback() {
  return false;
}

export async function beginDiscordSignIn() {}

export async function completeDiscordCallback() {
  return null;
}
