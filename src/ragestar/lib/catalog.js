/* ==========================================================================
   catalog.js — one shared fetch of the published model catalog
   --------------------------------------------------------------------------
   WHY THIS EXISTS

   useCatalog() in workspace.js returned a bare value with three meanings
   collapsed into two:

     null  =  still loading  OR  the read failed
     []    =  loaded, genuinely empty

   A failed read was therefore indistinguishable from a slow one, so the models
   page sat on "Loading the model catalog…" forever instead of saying it could
   not read it. Its catch block said as much: "a catalog we cannot read is not
   worth an error state". It is, because the alternative is a spinner that never
   resolves.

   Two components on the same page also each called the hook, which meant two
   identical requests per view and, worse, two independent pending states: the
   stats tiles fell back to the built-in fixtures while the list below them
   refused to, so the page showed "7 MODELS AVAILABLE" directly above
   "0 OF 0 MODELS". Same page, two answers.

   This module fixes both:

     · an explicit status — loading | ready | error — so a caller can tell the
       difference and say something true
     · one in-flight promise shared by every subscriber, so N components on a
       page make exactly one request and all agree on the result
   ========================================================================== */

import { useEffect, useState } from "react";
import { isConfigured } from "../../lib/supabase.js";
import { listPublicModels } from "../../lib/db.js";
import { mapPublicModel } from "./workspace.js";

/* The single shared cache. `status` is the whole point of this module. */
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
 * Back-compatible shape for callers that only want the rows and treat null as
 * "not answered yet": null while loading or on failure, an array once ready.
 *
 * Prefer useCatalogState() in anything that renders a loading or empty state,
 * because this signature cannot express the difference between the two.
 */
export function useCatalogRows() {
  const { models, status } = useCatalogState();
  return status === "ready" ? models : null;
}
