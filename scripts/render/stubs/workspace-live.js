/* ==========================================================================
   workspace-live — a stand-in for src/ragestar/lib/workspace.js
   --------------------------------------------------------------------------
   The real module calls lib/db.js, which talks to Supabase. The render
   harness replaces Supabase with a permissive proxy, so every call resolves
   to another proxy and nothing is ever actually wrong — which means a
   harness can never reproduce a *failure*. This double lets a test hand the
   screen an exact workspace object (including an actions.createKey that
   rejects) so the error paths can be exercised for real.

   It is loaded in place of the real file by RENDER_STUB_MAP. Doubles resolve
   their own relative imports against the real file's directory, so this one
   imports nothing.

   The fixture lives on globalThis.__WS_FIXTURE__ so the harness can change
   it between mounts.
   ========================================================================== */

export const MODALITIES = ["text", "code", "vision", "image", "audio", "embedding", "rerank"]

export const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }

export function mapPublicModel(m) {
  return m
}

export function useCatalog() {
  return globalThis.__WS_FIXTURE__?.catalog ?? null
}

export function useCatalogCount() {
  return null
}

export function useGatewayStats() {
  return null
}

export function useStatus() {
  return null
}

export function useStaff() {
  return { loading: false, error: null, stats: null, refresh: () => {} }
}

export function useWorkspace() {
  return globalThis.__WS_FIXTURE__?.ws
}
