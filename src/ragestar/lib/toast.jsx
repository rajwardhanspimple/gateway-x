import { createContext, useCallback, useContext, useRef, useState } from "react";
import { DotmSquare1 } from "../components/dotmatrix.jsx";
import { cn } from "./cn.js";

const ToastCtx = createContext(() => {});

export const useToast = () => useContext(ToastCtx);

const border = {
  ember: "border-brand-ember/45",
  lime: "border-brand-lime/45",
  coral: "border-brand-coral/45",
  gold: "border-brand-gold/45",
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((msg, tone = "ember") => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[95] flex w-[min(92vw,380px)] flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            className={cn(
              "pr-toast-in pointer-events-auto flex items-center gap-3 rounded-xl border bg-ink-900/95 px-4 py-3 text-left shadow-[0_24px_60px_-24px_rgba(0,0,0,0.95)] backdrop-blur-md",
              border[t.tone],
            )}
          >
            <DotmSquare1
              size={13}
              dotSize={2}
              color={{ ember: "#2447E8", lime: "#0D7A66", coral: "#E23D28", gold: "#C79A1E" }[t.tone]}
              speed={1.3}
              className="shrink-0"
              aria-hidden
            />
            <span className="text-[12.5px] leading-snug text-white/85">{t.msg}</span>
            <span className="ml-auto font-mono text-[9px] tracking-[0.18em] text-white/30 uppercase">✕</span>
          </button>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
