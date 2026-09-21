import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/* Content-Security-Policy for the production build.
   ------------------------------------------------------------------
   script-src has no 'unsafe-inline' and no 'unsafe-eval', so an injected
   <script> tag or an inline on* handler cannot run even if markup somehow
   reaches the DOM. Keep it in sync with public/_headers (the header version
   wins where the host supports it).

   Set VITE_ENABLE_REMOTE_MOTION=true only if you deliberately want the
   unpkg.com motion engine; the bundled fallback is used otherwise. */
const REMOTE_MOTION = process.env.VITE_ENABLE_REMOTE_MOTION === "true"
const MOTION_SRC = REMOTE_MOTION ? " https://unpkg.com" : ""

const CSP = [
  "default-src 'self'",
  `script-src 'self' https://apis.google.com${MOTION_SRC}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  /* Discord avatars on the profile card load from Discord's CDN. */
  "img-src 'self' data: blob: https://cdn.discordapp.com",
  /* Firebase Auth talks to identitytoolkit (sign-in, password reset, email
     links) and securetoken (ID token refresh); the Google popup loads from
     apis.google.com and completes on the project's *.firebaseapp.com handler. */
  `connect-src https://gw.ragestar.bond 'self' https://*.supabase.co wss://*.supabase.co https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.firebaseapp.com${MOTION_SRC}`,
  /* frame-src was 'none'. The Google sign-in popup and the invisible iframe
     Firebase uses to complete it both need to be framed, so this is the one
     directive the migration had to loosen - and only to Google's own hosts. */
  "frame-src https://*.firebaseapp.com https://accounts.google.com https://apis.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ")

function securityPlugin() {
  return {
    name: "ragestar-security-headers",

    /* Inject the CSP meta tag into the built index.html only. The dev server
       serves inline module preambles, so a strict policy there would break
       `npm run dev` without adding real protection locally. */
    transformIndexHtml(html, ctx) {
      if (ctx?.server) return html
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      )
    },

    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff")
        res.setHeader("Referrer-Policy", "no-referrer")
        res.setHeader("X-Frame-Options", "DENY")
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), securityPlugin()],
  base: "./",
  server: { port: 5173 },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        /* Split the two heavy SDKs into their own long-cached vendor chunks so
           the app code (which changes every release) no longer drags firebase
           and the supabase client through the same hash. This is what clears
           the >500 kB single-chunk warning. */
        manualChunks: {
          firebase: ["firebase/app", "firebase/auth"],
          supabase: ["@supabase/supabase-js"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
})
