import { cn } from "../lib/cn.js";
import { useInView } from "../hooks/useInView.js";

export function Reveal({ children, className, delay = 0, depth = false }) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "pr-reveal",
        depth && "pr-reveal-3d",
        inView && "pr-reveal-in",
        inView && depth && "pr-reveal-3d-in",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({ children, className, tone = "ember" }) {
  const tones = {
    ember: "text-orange-200 border-orange-400/30 bg-orange-500/10",
    coral: "text-rose-200 border-rose-400/30 bg-rose-500/10",
    gold: "text-amber-200 border-amber-400/30 bg-amber-500/10",
    lime: "text-lime-200 border-lime-400/35 bg-lime-400/10",
    neutral: "text-white/70 border-white/12 bg-white/5",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11px] tracking-widest uppercase",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Button({ children, href = "#", variant = "primary", className, onClick, type }) {
  const base =
    "group relative inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 font-medium text-sm transition-all duration-300 active:scale-[0.97]";
  const variants = {
    primary:
      "text-white bg-gradient-to-r from-orange-600 via-red-500 to-rose-500 shadow-[0_14px_40px_-14px_rgba(36,71,232,0.28)] hover:shadow-[0_20px_55px_-12px_rgba(36,71,232,0.22)] hover:-translate-y-0.5",
    outline:
      "text-white/85 border border-white/15 bg-white/5 backdrop-blur hover:bg-white/10 hover:text-white hover:-translate-y-0.5",
    ghost: "text-white/70 hover:text-white",
  };

  if (type) {
    return (
      <button type={type} onClick={onClick} className={cn(base, variants[variant], className)}>
        {children}
      </button>
    );
  }
  return (
    <a href={href} onClick={onClick} className={cn(base, variants[variant], className)}>
      {children}
    </a>
  );
}

export function SectionHeading({ eyebrow, title, body, align = "left", tone = "ember" }) {
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      <Reveal>
        <Badge tone={tone}>{eyebrow}</Badge>
      </Reveal>
      <Reveal delay={80} depth>
        <h2 className="font-display pr-text-shadow-deep mt-5 text-3xl leading-[1.06] font-semibold tracking-tight text-balance text-white sm:text-4xl md:text-[2.9rem]">
          {title}
        </h2>
      </Reveal>
      {body ? (
        <Reveal delay={150}>
          <p className="mt-5 text-[15px] leading-relaxed text-white/55 sm:text-base">{body}</p>
        </Reveal>
      ) : null}
    </div>
  );
}

export function TiltCard({ children, className, intensity = 9 }) {
  return (
    <div
      className="pr-perspective-1200 group/card h-full"
      onPointerMove={(e) => {
        const el = e.currentTarget.firstElementChild;
        if (!el) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `rotateX(${(-py * intensity).toFixed(2)}deg) rotateY(${(px * intensity).toFixed(2)}deg) translateZ(8px)`;
        el.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
      }}
      onPointerLeave={(e) => {
        const el = e.currentTarget.firstElementChild;
        if (!el) return;
        el.style.transform = "rotateX(0deg) rotateY(0deg) translateZ(0)";
      }}
    >
      <div className={cn("pr-tilt-card h-full", className)}>{children}</div>
    </div>
  );
}
