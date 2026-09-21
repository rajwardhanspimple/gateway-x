import React, { useEffect, useRef, forwardRef, useImperativeHandle } from "react";

/* The signature visual: live routing fabric.
   your app → RageStar core → 8 provider nodes. Packets flow, providers
   randomly degrade, packets bounce back and re-route (visible failover).
   - interactive: cursor attracts in-flight packets, click bursts traffic
   - ref.route(opts) lets the simulator fire visual packets              */

const PROVIDERS = ["OpenAI", "Anthropic", "Google", "DeepSeek", "Mistral", "Meta", "xAI", "Cohere"];
const PACKET_COLORS = ["#4fe3ff", "#8f7bff", "#b7f34c", "#4fe3ff", "#8f7bff"];

const Fabric = forwardRef(function Fabric({ rate = 1.1, labels = true, interactive = true, className = "" }, ref) {
  const canvasRef = useRef(null);
  const apiRef = useRef(null);

  useImperativeHandle(ref, () => ({
    route: (opts) => apiRef.current && apiRef.current.route(opts || {})
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0, h = 0;
    let app = null, core = null, providers = [];
    let packets = [];
    let degraded = -1;
    let degradeTimer = 0;
    let autoAcc = 0;
    let last = performance.now();
    let raf;
    const mouse = { x: -999, y: -999 };

    const layout = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) { requestAnimationFrame(layout); return; }
      w = r.width; h = r.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const padY = 34;
      const showLabels = labels && w > 460;
      const padX = showLabels ? 26 : 20;
      app = { x: padX + 8, y: h / 2, label: "your app" };
      core = { x: w * 0.42, y: h / 2, label: "RageStar" };
      providers = [];
      const usable = h - padY * 2;
      const n = PROVIDERS.length;
      for (let i = 0; i < n; i++) {
        providers.push({
          x: w - padX - (showLabels ? 14 : 4),
          y: padY + (usable * i) / (n - 1),
          label: PROVIDERS[i],
          health: 0.82 + ((i * 37) % 17) / 100
        });
      }
    };
    layout();
    window.addEventListener("resize", layout);

    const showLbl = () => labels && w > 460;

    const pickProvider = () => {
      let best = 0, bestScore = -1;
      for (let i = 0; i < providers.length; i++) {
        if (i === degraded) continue;
        const s = providers[i].health + Math.random() * 0.15;
        if (s > bestScore) { bestScore = s; best = i; }
      }
      return best;
    };

    const route = (opts = {}) => {
      const target = opts.provider != null ? opts.provider : pickProvider();
      packets.push({
        seg: 0, t: 0,
        speed: opts.speed || 1.35 + Math.random() * 0.5,
        target,
        color: opts.color || PACKET_COLORS[(Math.random() * PACKET_COLORS.length) | 0],
        fail: opts.fail !== false,
        failed: false, retried: false,
        size: opts.size || 2.2
      });
      if (packets.length > 46) packets.splice(0, packets.length - 46);
      return target;
    };
    apiRef.current = { route };

    const lerp = (a, b, t) => a + (b - a) * t;
    const packetPos = (p) => {
      const prov = providers[p.target];
      const bend = (prov.y - core.y) * 0.18;
      let x, y;
      if (p.seg === 0) {
        x = lerp(app.x, core.x, p.t);
        y = lerp(app.y, core.y, p.t) - Math.sin(p.t * Math.PI) * 10;
      } else {
        x = lerp(core.x, prov.x, p.t);
        y = lerp(core.y, prov.y, p.t) - Math.sin(p.t * Math.PI) * bend;
      }
      // cursor attraction
      if (interactive) {
        const rect = canvas.getBoundingClientRect();
        const mx = mouse.x, my = mouse.y;
        const dm = Math.hypot(x - mx, y - my);
        if (dm < 90 && dm > 4) {
          const pull = (1 - dm / 90) * 14;
          x += ((mx - x) / dm) * pull;
          y += ((my - y) / dm) * pull;
        }
      }
      return { x, y };
    };

    const onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    };
    const onLeave = () => { mouse.x = -999; mouse.y = -999; };
    const onClick = () => {
      if (!interactive) return;
      for (let i = 0; i < 6; i++) route({ force: true, speed: 1.6 + Math.random() * 0.8 });
    };
    if (interactive) {
      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseleave", onLeave);
      canvas.addEventListener("click", onClick);
    }

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, w, h);

      if (!reduced) {
        autoAcc += dt * rate;
        if (autoAcc > 1) { autoAcc = 0; route(); }
        degradeTimer += dt;
        if (degradeTimer > 7) {
          degradeTimer = 0;
          degraded = Math.random() < 0.5 ? (Math.random() * providers.length) | 0 : -1;
        }
      }

      // edges
      ctx.lineWidth = 1;
      const grad = ctx.createLinearGradient(app.x, 0, w, 0);
      grad.addColorStop(0, "rgba(79,227,255,.28)");
      grad.addColorStop(0.5, "rgba(143,123,255,.22)");
      grad.addColorStop(1, "rgba(139,160,255,.12)");
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(app.x, app.y);
      ctx.lineTo(core.x, core.y);
      ctx.stroke();
      for (let i = 0; i < providers.length; i++) {
        const prov = providers[i];
        const off = i === degraded;
        ctx.strokeStyle = off ? "rgba(255,107,107,.3)" : "rgba(139,160,255,.13)";
        ctx.beginPath();
        ctx.moveTo(core.x, core.y);
        const bend = (prov.y - core.y) * 0.18;
        ctx.quadraticCurveTo((core.x + prov.x) / 2, (core.y + prov.y) / 2 - bend, prov.x, prov.y);
        ctx.stroke();
        // degraded flicker ring
        if (off) {
          ctx.beginPath();
          ctx.strokeStyle = "rgba(255,107,107,.55)";
          ctx.setLineDash([3, 4]);
          ctx.arc(prov.x, prov.y, 10 + Math.sin(now / 160) * 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // packets
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        if (!p.failed && p.fail && p.target === degraded && p.seg === 1 && !p.retried) p.failed = true;
        if (p.failed) {
          p.t -= dt * p.speed * 1.4;
          if (p.t <= 0) {
            p.failed = false; p.retried = true; p.seg = 0; p.t = 0;
            p.color = "#b7f34c";
            p.target = pickProvider();
          }
        } else {
          p.t += dt * p.speed;
        }
        if (!p.failed && p.t >= 1) {
          if (p.seg === 0) { p.seg = 1; p.t = 0; }
          else { packets.splice(i, 1); continue; }
        }
        const pos = packetPos(p);
        ctx.beginPath();
        ctx.fillStyle = p.failed ? "#ff6b6b" : p.color;
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 8;
        ctx.arc(pos.x, pos.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // nodes
      const ring = (x, y, r, stroke, fill) => {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = 1.4; ctx.strokeStyle = stroke; ctx.stroke();
      };
      ring(app.x, app.y, 13, "rgba(79,227,255,.8)", "rgba(79,227,255,.08)");
      ring(app.x, app.y, 4, "#4fe3ff", "#4fe3ff");
      // core: pulsing
      const pulse = 16 + Math.sin(now / 500) * 2.5;
      ring(core.x, core.y, pulse + 8, "rgba(143,123,255,.25)", "transparent");
      ring(core.x, core.y, pulse, "rgba(143,123,255,.8)", "rgba(143,123,255,.12)");
      ring(core.x, core.y, 5, "#8f7bff", "#8f7bff");
      for (let i = 0; i < providers.length; i++) {
        const prov = providers[i];
        const off = i === degraded;
        ring(prov.x, prov.y, 9, off ? "rgba(255,107,107,.8)" : "rgba(139,160,255,.5)", off ? "rgba(255,107,107,.1)" : "rgba(139,160,255,.07)");
        ring(prov.x, prov.y, 3, off ? "#ff6b6b" : "#4fe3ff", off ? "#ff6b6b" : "#4fe3ff");
      }

      // labels
      if (showLbl()) {
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillStyle = "rgba(152,162,197,.9)";
        ctx.textAlign = "left";
        ctx.fillText(app.label, app.x - 2, app.y + 30);
        ctx.fillStyle = "rgba(143,123,255,.95)";
        ctx.fillText(core.label, core.x - 26, core.y + 38);
        ctx.textAlign = "right";
        for (let i = 0; i < providers.length; i++) {
          const prov = providers[i];
          ctx.fillStyle = i === degraded ? "rgba(255,107,107,.9)" : "rgba(95,106,140,.9)";
          ctx.fillText(prov.label + (i === degraded ? " · degraded" : ""), prov.x - 14, prov.y + 3);
        }
        ctx.textAlign = "left";
      }

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", layout);
      if (interactive) {
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
        canvas.removeEventListener("click", onClick);
      }
    };
  }, [rate, labels, interactive]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label="Live animation of requests routing from your app through RageStar to model providers"
    />
  );
});

export default Fabric;
