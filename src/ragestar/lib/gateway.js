/* ==========================================================================
   gateway.js — the one place the kit's copy resolves "our API".
   --------------------------------------------------------------------------
   The kit shipped with `api.ragestar.ai` hard-coded through its code samples and
   chrome. That is fine as brand copy, but a developer copying a curl snippet
   out of the docs needs the URL that actually routes.

   GATEWAY_URL comes from VITE_GATEWAY_URL, or is derived from the Supabase
   project as `<supabase>/functions/v1/router/v1`. When neither is configured
   we fall back to the brand host so the samples still read as real.
   ========================================================================== */

import { GATEWAY_URL } from "../../lib/config.js";

/** Full base URL including scheme, e.g. https://gw.example.com/functions/v1/router/v1 */
export const API_BASE = GATEWAY_URL || "https://api.ragestar.ai/v1";

/** Same thing without the scheme, for "base url" labels and Host: headers. */
export const API_HOST = API_BASE.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** True when the samples are pointing at a real, configured gateway. */
export const API_IS_REAL = Boolean(GATEWAY_URL);
