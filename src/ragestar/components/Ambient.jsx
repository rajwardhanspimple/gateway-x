import { useMemo } from "react";

const COLORS = ["#2447E8", "#1630B8", "#E23D28", "#101814", "#0D7A66", "#C79A1E"];

/**
 * Layered ambient backdrop: breathing cobalt/teal glows on drafting paper,
 * engineering grid, rising ink-and-cobalt motes, a slow scanner sweep,
 * vignette and grain. Pure CSS — cheap and seamless.
 */

export default function Ambient({ intensity = 26 }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: intensity }, (_, i) => ({
        left: Math.random() * 100,
        size: 1.5 + Math.random() * 2.4,
        dur: 12 + Math.random() * 18,
        delay: -Math.random() * 26,
        o: 0.2 + Math.random() * 0.45,
        x: (Math.random() - 0.5) * 160,
        color: COLORS[i % COLORS.length],
        soft: Math.random() > 0.5,
      })),
    [intensity],
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      {/* breathing cobalt wash, top */}
      <div
        className="pr-glow-breathe absolute -top-[22%] left-1/2 h-[75vh] w-[130vw] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(36,71,232,0.12), rgba(22,48,184,0.05) 45%, transparent 70%)",
        }}
      />
      {/* counter-wash, bottom right: instrument teal */}
      <div
        className="pr-glow-breathe absolute -right-[12%] -bottom-[28%] h-[75vh] w-[75vw]"
        style={{
          animationDelay: "-5.5s",
          background:
            "radial-gradient(ellipse at center, rgba(13,122,102,0.1), rgba(199,154,30,0.04) 50%, transparent 70%)",
        }}
      />
      {/* faint signal-red corner */}
      <div
        className="absolute -left-[14%] top-[30%] h-[50vh] w-[44vw]"
        style={{ background: "radial-gradient(ellipse at center, rgba(226,61,40,0.06), transparent 68%)" }}
      />
      {/* engineering grid */}
      <div className="pr-grid-backdrop absolute inset-0 opacity-70" />

      {/* rising motes */}
      
{sparks.map((s, i) => (
        <span
          key={i}
          className="pr-spark"
          style={{
            left: `${s.left}%`,
            width: s.size,
            height: s.size,
            background: s.color,
            boxShadow: s.soft ? `0 0 ${s.size * 2.4}px ${s.color}66` : undefined,
            animationDuration: `${s.dur}s`,
            animationDelay: `${s.delay}s`,
            filter: s.soft ? "blur(0.5px)" : undefined,
            ["--spark-o"]: s.o,
            ["--spark-x"]: `${s.x}px`,
          }}
        />
      ))}

      {/* slow scanner sweep */}
      <div className="pr-scanline" />

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
