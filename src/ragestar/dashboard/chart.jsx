import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";

export function useSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(0, r.width), h: Math.max(0, r.height) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, ...size };
}

/** Catmull-Rom → cubic bezier for smooth, non-overshooting curves. */
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export function Sparkline({ points, color = "#2447E8", className, fill = true }) {
  const { ref, w, h } = useSize();
  const id = useRef(`sp-${Math.random().toString(36).slice(2, 8)}`).current;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 3;
  const pts = points.map((p, i) => [
    (i / Math.max(1, points.length - 1)) * w,
    h - pad - ((p - min) / span) * (h - pad * 2),
  ]);
  const line = smoothPath(pts);

  return (
    <div ref={ref} className={cn("relative overflow-hidden", className)}>
      {w > 0 && (
        <svg width={w} height={h} className="block">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.38" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && line && (
            <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={`url(#${id})`} stroke="none" />
          )}
          <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
          {pts.length > 0 && (
            <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.2} fill={color} />
          )}
        </svg>
      )}
    </div>
  );
}

export function AreaChart({
  series,
  labels,
  height = 260,
  format = (v) => v.toFixed(1),
  unit = "",
  yTicks = 4,
}) {
  const { ref, w } = useSize();
  const [hover, setHover] = useState(null);
  const uid = useRef(`ac-${Math.random().toString(36).slice(2, 8)}`).current;

  const padL = 46;
  const padR = 14;
  const padT = 18;
  const padB = 28;
  const innerW = Math.max(10, w - padL - padR);
  const innerH = height - padT - padB;

  const all = series.flatMap((s) => s.values);
  let min = Math.min(...all);
  let max = Math.max(...all);
  const head = (max - min) * 0.14 || 1;
  min -= head * 0.6;
  max += head;
  const span = max - min || 1;

  const x = (i) => padL + (i / Math.max(1, labels.length - 1)) * innerW;
  const y = (v) => padT + innerH - ((v - min) / span) * innerH;

  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => min + (span / yTicks) * i);
  const labelStep = Math.max(1, Math.ceil(labels.length / 7));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left - padL;
    const idx = Math.round((rel / innerW) * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, idx)));
  };

  return (
    <div className="relative">
      <div
        ref={ref}
        className="relative"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {w > 0 && (
          <svg width={w} height={height} className="block">
            <defs>
              {series.map((s) => (
                <linearGradient key={s.id} id={`${uid}-${s.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity="0.34" />
                  <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                </linearGradient>
              ))}
            </defs>

            {ticks.map((t, i) => (
              <g key={i}>
                <line
                  x1={padL}
                  x2={w - padR}
                  y1={y(t)}
                  y2={y(t)}
                  stroke="rgba(16,24,20,0.09)"
                  strokeDasharray={i === 0 ? "0" : "3 6"}
                />
                <text
                  x={padL - 10}
                  y={y(t) + 3.5}
                  textAnchor="end"
                  className="fill-white/35"
                  style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                >
                  {format(t)}
                  {unit}
                </text>
              </g>
            ))}

            {labels.map((l, i) =>
              i % labelStep === 0 ? (
                <text
                  key={`${l}-${i}`}
                  x={x(i)}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-white/30"
                  style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                >
                  {l}
                </text>
              ) : null,
            )}

            {series.map((s) => {
              const pts = s.values.map((v, i) => [x(i), y(v)]);
              const line = smoothPath(pts);
              return (
                <g key={s.id}>
                  {line ? (
                    <path d={`${line} L ${x(s.values.length - 1)} ${padT + innerH} L ${padL} ${padT + innerH} Z`} fill={`url(#${uid}-${s.id})`} />
                  ) : null}
                  <path
                    d={line}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {pts.map((p, i) =>
                    i === pts.length - 1 && hover === null ? (
                      <circle key={i} cx={p[0]} cy={p[1]} r={3} fill={s.color} />
                    ) : null,
                  )}
                </g>
              );
            })}

            {hover !== null && (
              <g>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={padT - 6}
                  y2={padT + innerH}
                  stroke="rgba(16,24,20,0.32)"
                />
                {series.map((s) => (
                  <g key={s.id}>
                    <circle cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={5.5} fill={s.color} opacity={0.22} />
                    <circle
                      cx={x(hover)}
                      cy={y(s.values[hover] ?? 0)}
                      r={3}
                      fill="#101814"
                      stroke={s.color}
                      strokeWidth={2}
                    />
                  </g>
                ))}
              </g>
            )}
          </svg>
        )}

        {hover !== null && w > 0 && (
          <div
            className="pr-glass-strong pointer-events-none absolute top-2 z-20 min-w-[148px] rounded-xl px-3 py-2.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]"
            style={{
              left: Math.min(Math.max(x(hover) - 74, 4), Math.max(4, w - 156)),
            }}
          >
            <div className="font-mono text-[10px] tracking-[0.18em] text-white/45 uppercase">
              {labels[hover]}
            </div>
            <div className="mt-2 space-y-1.5">
              {series.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-2 text-[11.5px] text-white/70">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                    {s.name}
                  </span>
                  <span className="font-mono text-[11.5px] tabular-nums text-white">
                    {format(s.values[hover] ?? 0)}
                    {unit}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Animated bar meter used in the breakdown cards. */
export function Bar({ pct, color, delay = 0 }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(pct), 120 + delay);
    return () => clearTimeout(t);
  }, [pct, delay]);
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
      <div
        className="h-full rounded-full transition-all duration-1000 ease-out"
        style={{ width: `${w}%`, background: `linear-gradient(90deg, ${color}bb, ${color})` }}
      />
    </div>
  );
}
