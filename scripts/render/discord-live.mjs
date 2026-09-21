/* ==========================================================================
   discord-live — the Discord gate on the screen where it can be fixed
   --------------------------------------------------------------------------
   v12.12 turns app_settings.discord_required on: from then on the router
   serves an account only when it has a linked Discord that is in the community
   server. The card that satisfies that requirement lives on the dashboard's
   Settings view (src/ragestar/dashboard/DiscordPanel.jsx).

   Two things have to be true or the policy is a trap rather than a gate:

     1. the card is REACHABLE — it renders on Settings, which is a live view of
        the kit shell, not on the console Profile tab that #/console retirement
        left orphaned
     2. it TELLS THE TRUTH — a blocked account sees "API access is paused" and
        the button that fixes it; an account that is linked, joined, or simply
        not gated sees no alarm at all

   Every scenario mounts the real Dashboard on view="settings" and reads the
   rendered text. lib/db.js and lib/discord.js are doubled (stubs/db-live,
   stubs/discord-live) so the gate flag, the identity and the server verdict
   can each be set exactly.
   ========================================================================== */

/* jsdom first — everything imported afterwards must see a live DOM. */
const { JSDOM } = await import("jsdom");

const dom = new JSDOM(
  '<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://render-test.example.com/#/dashboard/settings", pretendToBeVisual: true },
);

const promote = (key, value) => {
  if (globalThis[key] === undefined) {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
      /* read-only global in this runtime — globals.mjs fills the gaps */
    }
  }
};
for (const key of [
  "window",
  "document",
  "location",
  "localStorage",
  "sessionStorage",
  "CustomEvent",
  "Event",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
]) {
  promote(key, dom.window[key]);
}

await import("./globals.mjs");

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const Dashboard = (await import("../../src/ragestar/dashboard/Dashboard.jsx")).default;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realError = console.error.bind(console);
const ACT_NOISE = /was not wrapped in act\(/;
console.error = (...args) => {
  if (typeof args[0] === "string" && ACT_NOISE.test(args[0])) return;
  realError(...args);
};

/* ------------------------------------------------------------------ helpers */

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

let boundaryError = null;
class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err: String(err) };
  }
  componentDidCatch(err) {
    boundaryError = err;
  }
  render() {
    return this.state.err
      ? React.createElement("div", { id: "crash" }, this.state.err)
      : this.props.children;
  }
}

const settle = (ms = 60) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

const buttons = () => [...document.querySelectorAll("button")];
const byText = (needle) =>
  buttons().find((b) => (b.textContent || "").trim().toLowerCase().includes(needle.toLowerCase()));

const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
};

/** Everything the user can read on the mounted screen. */
const screenText = () => (document.body.textContent || "").replace(/\s+/g, " ").trim();

/** The one screen currently mounted, so each scenario starts from blank. */
let current = null;
async function unmountCurrent() {
  if (!current) return;
  const prev = current;
  current = null;
  await prev.unmount();
}

/** Mount the dashboard on Settings with a given gate/identity pair. */
async function mountSettings({ gate, discord }) {
  /* One screen at a time. Without this the assertions read the union of every
     previously mounted panel — a banner from scenario A would "fail" scenario
     C, and A's Connect button would satisfy B. */
  await unmountCurrent();

  boundaryError = null;
  globalThis.__GATE__ = gate || {};
  globalThis.__DISCORD__ = discord || {};

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(
        Boundary,
        null,
        React.createElement(Dashboard, {
          view: "settings",
          session: {
            user: { email: "dev@example.com" },
            profile: { plan: "dev" },
            org: "acme",
            plan: "dev",
            name: "Dev User",
            email: "dev@example.com",
          },
          navigate: () => {},
          onExit: () => {},
          onSignOut: () => {},
        }),
      ),
    );
  });
  await settle();

  current = {
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };

  return {
    text: () => screenText(),
    unmount: current.unmount,
  };
}

const LINKED_NOT_JOINED = {
  identity: {
    discord_id: "1234567890",
    username: "ghost.ragestar",
    global_name: "RageStar",
    guild_member: false,
    avatar: "abc",
  },
};

const LINKED_AND_JOINED = {
  identity: {
    discord_id: "1234567890",
    username: "ghost.ragestar",
    global_name: "RageStar",
    guild_member: true,
    avatar: "abc",
  },
};

const PAUSED = /API access is paused/i;

/* ---------------------------------------------------------------- scenario A
   The gate is on and nothing is linked. This is the account the policy is
   aimed at: it must be told it is blocked, and given the button that unblocks
   it — on a screen it can actually reach. */

const a = await mountSettings({ gate: { required: true }, discord: {} });
{
  const text = a.text();
  check(
    "A · the Discord card renders on the live Settings screen",
    /Discord/i.test(text) && !!byText("Connect Discord"),
    text.includes("Discord") ? "" : "no Discord section on the settings view",
  );
  check("A · mounting produced no render error", !boundaryError, boundaryError ? String(boundaryError) : "");
  check(
    "A · an unlinked account is told API access is paused",
    PAUSED.test(text),
    PAUSED.test(text) ? "" : `no "paused" banner on: ${JSON.stringify(text.slice(0, 220))}`,
  );
  check(
    "A · and is offered the button that fixes it",
    !!byText("Connect Discord"),
    "no Connect Discord button",
  );
  check(
    "A · the panel is marked as required",
    /required/i.test(text),
    "no required chip while the gate is on and unmet",
  );
}

/* ---------------------------------------------------------------- scenario B
   Linked, but not in the community server. A different failure, so a
   different instruction — and the retry button, not "connect". */

const b = await mountSettings({ gate: { required: true }, discord: LINKED_NOT_JOINED });
{
  const text = b.text();
  check(
    "B · linked-but-not-joined is still blocked",
    PAUSED.test(text) && /community server/i.test(text),
    `banner=${PAUSED.test(text)} server=${/community server/i.test(text)}`,
  );
  check(
    "B · the fix offered is the server join, not a reconnect",
    !!byText("Retry server join") && !byText("Connect Discord"),
    `retry=${!!byText("Retry server join")} connect=${!!byText("Connect Discord")}`,
  );
  check(
    "B · the account's identity is shown",
    /ghost\.ragestar/.test(text) && /Not joined/i.test(text),
    `username=${/ghost\.ragestar/.test(text)} verdict=${/Not joined/i.test(text)}`,
  );
}

/* ---------------------------------------------------------------- scenario C
   Compliant. The gate is on but this account has satisfied it, so there must
   be no alarm — a false "paused" banner on a working account is its own bug. */

const c = await mountSettings({ gate: { required: true }, discord: LINKED_AND_JOINED });
{
  const text = c.text();
  check(
    "C · a compliant account sees no pause banner",
    !PAUSED.test(text),
    "blocked banner shown to an account that satisfies the gate",
  );
  check(
    "C · and is shown as joined",
    /Joined/i.test(text) && /ghost\.ragestar/.test(text),
    `joined=${/Joined/i.test(text)}`,
  );
  check(
    "C · with a way to disconnect",
    !!byText("Disconnect"),
    "no Disconnect button for a linked account",
  );
}

/* ---------------------------------------------------------------- scenario D
   Gate off. Linking is still offered, but nothing is blocked and nothing is
   labelled required — the policy is relaxed, not broken. */

const d = await mountSettings({ gate: { required: false }, discord: {} });
{
  const text = d.text();
  check(
    "D · with the gate off nothing is paused",
    !PAUSED.test(text) && !/required/i.test(text),
    `paused=${PAUSED.test(text)} required=${/required/i.test(text)}`,
  );
  check(
    "D · linking is still offered",
    !!byText("Connect Discord"),
    "the card should still invite a link when the gate is off",
  );
}

/* ---------------------------------------------------------------- scenario E
   The gate flag arrives asynchronously. While the answer is still in flight the
   card must not flash a false alarm at an account that may well be compliant. */

const e = await mountSettings({
  gate: { required: true },
  discord: { identity: LINKED_AND_JOINED.identity, slow: true },
});
{
  check(
    "E · a known-good account is never shown a pause banner",
    !PAUSED.test(e.text()),
    "the banner appeared for a joined account",
  );
}

/* ---------------------------------------------------------------- scenario F
   Behaviour when the identity service is not installed (v12.6 missing): say
   so, and do not claim the account is blocked. */

const f = await mountSettings({ gate: { required: true }, discord: { unavailable: true } });
{
  const text = f.text();
  check(
    "F · an un-installed identity table is explained, not blamed on the user",
    /Not installed/i.test(text) && !PAUSED.test(text),
    `installed-note=${/Not installed/i.test(text)} paused=${PAUSED.test(text)}`,
  );
}

/* ---------------------------------------------------------------- scenario G
   The buttons are actually wired: Connect starts the OAuth redirect, and a
   disconnect that fails surfaces the reason instead of silently doing nothing. */

let connected = 0;
let disconnected = 0;
const g = await mountSettings({
  gate: { required: true },
  discord: {
    ...LINKED_AND_JOINED,
    onConnect: () => {
      connected += 1;
    },
    onDisconnect: () => {
      disconnected += 1;
    },
  },
});

dom.window.confirm = () => true;
{
  const btn = byText("Disconnect");
  if (btn) await click(btn);
  check(
    "G · Disconnect reaches the disconnect call",
    disconnected === 1,
    `disconnect calls=${disconnected}`,
  );
  const after = g.text();
  check(
    "G · and the outcome is reported back on screen",
    /disconnected/i.test(after),
    "no confirmation after disconnecting",
  );
}

const h = await mountSettings({
  gate: { required: true },
  discord: { disconnectFails: true, ...LINKED_AND_JOINED, onDisconnect: () => {} },
});
{
  dom.window.confirm = () => true;
  const btn = byText("Disconnect");
  if (btn) await click(btn);
  check(
    "H · a failed disconnect says so instead of failing silently",
    /network down|Could not disconnect/i.test(h.text()),
    `screen: ${JSON.stringify(h.text().slice(-200))}`,
  );
}

/* ------------------------------------------------------- the connect button */

const i = await mountSettings({
  gate: { required: true },
  discord: {
    onConnect: () => {
      connected += 1;
    },
  },
});
{
  const btn = byText("Connect Discord");
  if (btn) await click(btn);
  check(
    "I · Connect Discord reaches the connect call",
    connected === 1,
    `connect calls=${connected}`,
  );
  check(
    "I · the invite link is offered alongside it",
    /discord\.gg\/render-test/.test(document.body.innerHTML),
    "no invite link rendered",
  );
}

/* ------------------------------------------------------------------ report */

const badge = (ok) => (ok ? "\u001b[32m ok \u001b[0m" : "\u001b[31mFAIL\u001b[0m");
const failed = results.filter((r) => !r.ok);

console.log("\u001b[1mdiscord-live\u001b[0m  the Discord gate on Settings");
console.log();
for (const r of results) {
  console.log(` ${badge(r.ok)}  ${r.name}`);
  if (!r.ok && r.detail) console.log(`        ${r.detail}`);
}
console.log();
console.log(
  failed.length
    ? `\u001b[31m${failed.length} of ${results.length} checks failed\u001b[0m`
    : `\u001b[32mall ${results.length} checks passed\u001b[0m`,
);
console.log();

process.exit(failed.length ? 1 : 0);
