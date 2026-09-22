/* ==========================================================================
   catalog.js — one shared fetch of the published model catalog
   --------------------------------------------------------------------------
   WHY THIS EXISTS

   The old useCatalog() in workspace.js returned a bare value with three
   meanings collapsed into two:

     null  =  still loading  OR  the read failed
     []    =  loaded, genuinely empty

   A failed read was therefore indistinguishable from a slow one, so the models
   page sat on "Loading the model catalog…" forever instead of saying it could
   not read it. Its catch block said as much: "a catalog we cannot read is not
   worth an error state". It is, because the alternative is a spinner that never
   resolves.

   Four components also each called the hook, which meant four identical
   requests per page view and, worse, independent pending states: the models
   page's stat tiles fell back to the built-in fixtures while the list below
   them refused to, so the page showed "7 MODELS AVAILABLE" directly above
   "0 OF 0 MODELS". Same page, two answers.

   This module fixes both:

     · an explicit status — loading | ready | error — so a caller can tell the
       difference and say something true
     · one in-flight promise shared by every subscriber, so N components on a
       page make exactly one request and all agree on the result

   mapPublicModel lives HERE rather than in workspace.js. workspace.js
   re-exports it and delegates its own useCatalog to this module, so there is
   one fetch and one mapper; putting the mapper the other way round would make
   the two modules import each other.
   ========================================================================== */

import { useEffect, useState } from "react";
import { isConfigured } from "../../lib/supabase.js";
import { listPublicModels } from "../../lib/db.js";

export const MODALITIES = ["text", "code", "vision", "image", "audio", "embedding", "rerank"];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * public_models row -> the kit's model object.
 *
 * The kit renders `{model.ttft}ms` and sorts by it, but the gateway does not
 * measure per-model TTFT, so it is null here and the call sites print an em
 * dash rather than a zero that reads as a measurement. Everything the gateway
 * does know — context, prices, capabilities, status — is real.
 */
export function mapPublicModel(m) {
  const id = String(m.id ?? m.public_id ?? "");
  const capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
  const modality = capabilities.filter((c) => MODALITIES.includes(String(c).toLowerCase()));
  const status = String(m.status ?? "").toLowerCase();

  return {
    id,
    name: m.name || m.display_name || id,
    /* "openai/gpt-4o" -> "openai"; a bare id is served by the gateway itself */
    provider: id.includes("/") ? id.split("/")[0] : "gateway",
    blurb: m.description || "",
    context: num(m.context_window),
    priceIn: num(m.price_in_per_m),
    priceOut: num(m.price_out_per_m),
    modality: modality.length ? modality : ["text"],
    ttft: null,
    throughput: null,
    license: "Proprietary",
    status: status === "beta" ? "beta" : status === "preview" ? "preview" : "ga",
    tags: capabilities.slice(0, 3).map(String),
    strengths: [],
  };
}

/* ------------------------------------------------------------ shared state */

/* `status` is the whole point of this module. */
let state = {
  status: isConfigured ? "loading" : "error",
  models: [],
  error: isConfigured ? null : "The gateway is not configured in this build.",
};

/* Subscribers to notify when the shared state moves. */
const listeners = new Set();

/* The in-flight request, so concurrent mounts share one fetch. */
let inFlight = null;

function publish(next) {
  state = next;
  for (const fn of listeners) fn(state);
}

function load() {
  if (!isConfigured) return Promise.resolve(state);
  if (inFlight) return inFlight;
  if (state.status === "ready") return Promise.resolve(state);

  inFlight = listPublicModels()
    .then((rows) => {
      publish({
        status: "ready",
        models: Array.isArray(rows) ? rows.map(mapPublicModel) : [],
        error: null,
      });
      return state;
    })
    .catch((err) => {
      /* An unreadable catalog IS an error state. Saying so is the difference
         between a page that explains itself and one that spins forever. */
      publish({
        status: "error",
        models: [],
        error: err?.message || "Could not read the model catalog.",
      });
      return state;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Force a re-read, e.g. behind a "try again" button on an error state. */
export function refreshCatalog() {
  if (!isConfigured) return Promise.resolve(state);
  if (!inFlight) {
    publish({ status: "loading", models: state.models, error: null });
  }
  return load();
}

/**
 * The published catalog, with its loading state made explicit.
 *
 * @returns {{
 *   models: Array<object>,   the mapped rows; [] while loading or on failure
 *   status: "loading"|"ready"|"error",
 *   error: string|null,
 *   loading: boolean,        convenience for status === "loading"
 *   failed: boolean,         convenience for status === "error"
 *   refresh: () => Promise,  re-read the catalog
 * }}
 *
 * Every consumer on a page shares one request and one answer, so two
 * components can no longer disagree about how many models exist.
 */
export function useCatalogState() {
  const [snapshot, setSnapshot] = useState(state);

  useEffect(() => {
    listeners.add(setSnapshot);
    /* Adopt whatever the shared state already holds, then make sure a read has
       been kicked off. If one is in flight this joins it rather than starting
       a second. */
    setSnapshot(state);
    load();
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);

  return {
    models: snapshot.models,
    status: snapshot.status,
    error: snapshot.error,
    loading: snapshot.status === "loading",
    failed: snapshot.status === "error",
    refresh: refreshCatalog,
  };
}

/**
 * Back-compatible shape: null while loading or on failure, an array once ready.
 *
 * Prefer useCatalogState() in anything that renders a loading or empty state,
 * because this signature cannot express the difference between the two. This
 * exists so the existing callers share the one fetch without each needing a
 * rewrite.
 */
export function useCatalogRows() {
  const { models, status } = useCatalogState();
  return status === "ready" ? models : null;
}

/** Number of published models, or null until the catalog answers. */
export function useCatalogCountShared() {
  const { models, status } = useCatalogState();
  return status === "ready" ? models.length : null;
}
