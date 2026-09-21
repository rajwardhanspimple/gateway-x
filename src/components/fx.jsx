import React, { useEffect, useRef, useState } from "react";

/* ---------------------------------------------------------------- Reveal */
export function Reveal({ children, as: Tag = "div", variant, delay = 0, className = "", ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && (el.classList.add("rv-in"), io.disconnect())),
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref} data-reveal={variant || true} className={className} style={{ "--rv-delay": `${delay}s` }} {...rest}>
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------- RevealGroup */
export function RevealGroup({ children, className = "", step = 0.09, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    Array.from(el.children).forEach((c, i) => c.style.setProperty("--rv-delay", `${i * step}s`));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && (el.classList.add("rv-in"), io.disconnect())),
      { threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [step]);
  return (
    <div ref={ref} className={`rv-group ${className}`} {...rest}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- Scramble */
const GLYPHS = "!<>-_\\/[]{}—=+*^?#01";
export function Scramble({ text, className = "", speed = 28, once = true }) {
  const ref = useRef(null);
  const [out, setOut] = useState(text);
  const played = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const run = () => {
      if (played.current && once) return;
      played.current = true;
      if (reduced) { setOut(text); return; }
      let frame = 0;
      const total = text.length;
      const iv = setInterval(() => {
        frame++;
        const settled = Math.floor(frame * 0.9);
        let s = "";
        for (let i = 0; i < total; i++) {
          const ch = text[i];
          if (ch === " " || i < settled) s += ch;
          else s += GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        setOut(s);
        if (settled >= total) { clearInterval(iv); setOut(text); }
      }, speed);
    };
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => en.isIntersecting && (run(), io.disconnect())),
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [text, speed, once]);

  return (
    <span ref={ref} className={className} aria-label={text}>
      {out}
    </span>
  );
}

/* --------------------------------------------------------------- Counter */
export function Counter({ to, decimals = 0, suffix = "", prefix = "", className = "", jitter = 0 }) {
  const ref = useRef(null);
  const [val, setVal] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || document.documentElement.classList.contains("qa-all")) { setVal(to); return; }
    let iv2;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          io.disconnect();
          if (reduced) { setVal(to); return; }
          const t0 = performance.now();
          const dur = 1400;
          const tick = (now) => {
            const p = Math.min(1, (now - t0) / dur);
            const e = 1 - Math.pow(1 - p, 3);
            setVal(to * e);
            if (p < 1) requestAnimationFrame(tick);
            else if (jitter > 0) {
              iv2 = setInterval(() => setVal(to + (Math.random() - 0.5) * 2 * jitter), 900);
            }
          };
          requestAnimationFrame(tick);
        }),
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => { io.disconnect(); if (iv2) clearInterval(iv2); };
  }, [to, jitter]);

  return (
    <span ref={ref} className={`tabular ${className}`}>
      {prefix}{val.toFixed(decimals)}{suffix}
    </span>
  );
}

/* --------------------------------------------------------------- Marquee */
export function Marquee({ items, className = "" }) {
  const row = (key) => (
    <React.Fragment key={key}>
      {items.map((it, i) => (
        <span className="m-item" key={key + i}><i />{it}</span>
      ))}
    </React.Fragment>
  );
  return (
    <div className={`marquee ${className}`} aria-hidden="true">
      <div className="marquee-track">{row("a")}{row("b")}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Tilt */
export function Tilt({ children, className = "", max = 7 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (reduced || !fine) return;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      el.style.transform = `perspective(800px) rotateY(${(px - 0.5) * max}deg) rotateX(${(0.5 - py) * max}deg) translateY(-3px)`;
      el.style.setProperty("--gx", `${px * 100}%`);
      el.style.setProperty("--gy", `${py * 100}%`);
    };
    const onLeave = () => { el.style.transform = ""; };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => { el.removeEventListener("mousemove", onMove); el.removeEventListener("mouseleave", onLeave); };
  }, [max]);
  return (
    <div ref={ref} className={`tilt ${className}`}>
      <div className="tilt-glare" aria-hidden="true" />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ Typewriter */
export function Typewriter({ text, className = "", speed = 14, startDelay = 0 }) {
  const ref = useRef(null);
  const [n, setN] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          io.disconnect();
          setStarted(true);
          if (reduced) { setN(text.length); return; }
          setTimeout(() => {
            let i = 0;
            const iv = setInterval(() => {
              i += 1 + ((Math.random() * 2) | 0);
              setN(Math.min(i, text.length));
              if (i >= text.length) clearInterval(iv);
            }, speed);
          }, startDelay);
        }),
      { threshold: 0.3 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [text, speed, startDelay]);

  return (
    <span ref={ref} className={className} aria-label={text}>
      {text.slice(0, n)}
      {started && n < text.length && <span className="tw-caret" aria-hidden="true" />}
    </span>
  );
}

/* ---------------------------------------------------------- Char cascade */
export function CharCascade({ text, className = "", baseDelay = 0, step = 0.028 }) {
  return (
    <span className={`char-cascade ${className}`} aria-label={text}>
      {text.split("").map((ch, i) => (
        <span key={i} className="ch" aria-hidden="true" style={{ "--ch-delay": `${baseDelay + i * step}s` }}>
          {ch === " " ? "\u00A0" : ch}
        </span>
      ))}
    </span>
  );
}
