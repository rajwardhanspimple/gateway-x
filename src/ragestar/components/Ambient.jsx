import { useMemo } from "react";
import GlyphMatrix from "./GlyphMatrix.jsx";

/**
 * Layered ambient backdrop: a shifting glyph matrix over drafting paper, the
 * engineering grid, a soft cobalt wash, vignette and grain.
 *
 * The glyph matrix (components/GlyphMatrix.jsx, ported from Magic UI) is the
 * layer that carries the character now. It reads as a terminal field rather
 * than decoration, which suits a gateway, and it follows the appearance on its
 * own through the data-theme contract.
 *
 * `intensity` scales the matrix density: the busier marketing pages get a
 * tighter cell grid than the dashboard, which stays calm behind real data.
 */

export default function Ambient({ intensity = 26 }) {
  /* 26 -> 15px cells and a livelier mutation rate; 12 -> 20px and calmer.
     The dashboard and admin panel pass 12. */
  const matrix = useMemo(() => {
    const busy = intensity >= 20;
    return {
      cellSize: busy ? 15 : 20,
      mutationRate: busy ? 0.035 : 0.02,
      interval: busy ? 110 : 160,
    };
  }, [intensity]);

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {/* one soft cobalt wash for depth, top */}
      <div
        className="absolute -top-[22%] left-1/2 h-[75vh] w-[130vw] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(36,71,232,0.1), rgba(22,48,184,0.04) 45%, transparent 70%)",
        }}
      />

      {/* engineering grid */}
      <div className="pr-grid-backdrop absolute inset-0 opacity-70" />

      {/* the glyph matrix — the layer that gives the page its character.
          Masked so it reads as texture behind content rather than competing
          with it: strongest at the top, gone by the middle of the fold. */}
      <div
        className="absolute inset-0 opacity-[0.55]"
        style={{
          maskImage: "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.5) 45%, transparent 85%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, #000 0%, rgba(0,0,0,0.5) 45%, transparent 85%)",
        }}
      >
        <GlyphMatrix
          glyphs="01·\u2022+*/\\<>="
          cellSize={matrix.cellSize}
          mutationRate={matrix.mutationRate}
          interval={matrix.interval}
          fadeBottom={0.6}
        />
      </div>

      {/* vignette — ink at the frame edges */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 120% 92% at 50% 38%, transparent 46%, rgba(16,24,20,0.07) 80%, rgba(16,24,20,0.16))",
        }}
      />
      {/* grain */}
      <div className="pr-noise absolute inset-0 opacity-[0.055]" />
    </div>
  );
}
