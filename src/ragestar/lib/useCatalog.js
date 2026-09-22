/* ==========================================================================
   useCatalog.js — drop-in replacement for workspace.js's useCatalog
   --------------------------------------------------------------------------
   WHY A SEPARATE FILE

   Four components called workspace.js's useCatalog(), so a page made up to four
   identical requests for the same catalog AND kept four independent pending
   states. That is what put "7 MODELS AVAILABLE" directly above "0 OF 0 MODELS"
   on the models page: the stat tiles fell back to the seven built-in fixtures
   while the list below them deliberately refused to.

   The fix belongs in the hook, but workspace.js is 779 lines of real logic and
   the only safe way to change a file here is to replace it whole. Rewriting it
   to change one function is a bad trade. So this module holds the replacement
   and the call sites switch their import path — a one-line change per file.

   Everything real lives in ./catalog.js: one shared in-flight request, one
   shared result, and an explicit loading | ready | error status so a caller can
   tell a failed read from a slow one. The old hook could not: it returned null
   for both and its catch block swallowed the error, which is why a failed
   catalog read showed "Loading the model catalog…" forever.

   MIGRATION

     before   import { useCatalog } from "../lib/workspace.js";
     after    import { useCatalog } from "../lib/useCatalog.js";

   The signature is identical — null while pending or failed, an array once
   ready — so nothing else in a call site changes. New code that renders a
   loading or empty state should import useCatalogState from ./catalog.js
   instead and say which of the two it is.
   ========================================================================== */

export { useCatalogRows as useCatalog, useCatalogCountShared as useCatalogCount, useCatalogState, refreshCatalog, mapPublicModel, MODALITIES } from "./catalog.js";
