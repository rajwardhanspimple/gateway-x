/* Smoke test: server-render every RageStar kit view through vite's SSR loader.
   Catches module-level crashes and render-time errors that esbuild can't.
   Run: node scripts/check-ragestar.mjs */
import { createServer } from "vite";
import React from "react";
import { renderToString } from "react-dom/server";

const session = {
  email: "maya@lumenmotors.com",
  name: "Maya Renton",
  org: "lumen",
  plan: "Scale",
  credits: 1284.5,
};

const dashViews = ["overview", "models", "playground", "keys", "usage", "settings"];
const adminViews = ["overview", "orgs", "models", "incidents"];

let failures = 0;

const server = await createServer({
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { default: Dashboard } = await server.ssrLoadModule("/src/ragestar/dashboard/Dashboard.jsx");
  const { default: AdminPanel } = await server.ssrLoadModule("/src/ragestar/admin/Admin.jsx");
  const { default: RageStarApp } = await server.ssrLoadModule("/src/ragestar/RageStarApp.jsx");

  for (const view of dashViews) {
    try {
      const html = renderToString(
        React.createElement(Dashboard, {
          session,
          view,
          navigate: () => {},
          onExit: () => {},
          onSignOut: () => {},
          isStaff: true,
        }),
      );
      console.log(`ok   dashboard/${view} — ${html.length.toLocaleString()} chars`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL dashboard/${view}: ${err.message}`);
    }
  }

  for (const view of adminViews) {
    try {
      const html = renderToString(
        React.createElement(AdminPanel, {
          session,
          view,
          navigate: () => {},
          onExit: () => {},
          isStaff: true,
        }),
      );
      console.log(`ok   admin/${view} — ${html.length.toLocaleString()} chars`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL admin/${view}: ${err.message}`);
    }
  }

  try {
    const html = renderToString(React.createElement(RageStarApp));
    console.log(`ok   RageStarApp shell — ${html.length.toLocaleString()} chars`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL RageStarApp shell: ${err.message}`);
  }
} catch (err) {
  failures += 1;
  console.error(`FAIL module load: ${err.stack || err.message}`);
} finally {
  await server.close();
}

if (failures) {
  console.error(`\n${failures} ragestar view(s) failed to render`);
  process.exit(1);
}
console.log("\nall ragestar views render");
