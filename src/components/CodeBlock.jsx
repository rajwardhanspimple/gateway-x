import React, { useState } from "react";
import { Icon } from "./brand.jsx";
import { safeText } from "../lib/sanitize.js";

/* Code block with window chrome + copy button.

   Security note: this component used to render a pre-highlighted `html` string
   through dangerouslySetInnerHTML, which turned any string that reached it
   (model ids, gateway URLs, upstream error text) into a script-execution
   vector. Code is now rendered as text only — React escapes it — and the
   optional `tokens` prop takes structured { text, kind } pairs when you want
   colour, so markup can never come from data. */
export default function CodeBlock({ title = "terminal", code, raw, tokens, footer }) {
  const [copied, setCopied] = useState(false);
  const text = safeText(code ?? raw ?? "", 20000);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw ?? text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = raw ?? text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="code">
      <div className="code-head">
        <span className="dots"><i /><i /><i /></span>
        <span>{safeText(title, 120)}</span>
        <button className="copy-btn" type="button" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} />
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>
          {Array.isArray(tokens) && tokens.length
            ? tokens.map((t, i) => (
                <span key={i} className={t?.kind ? `tok tok-${String(t.kind).replace(/[^a-z0-9-]/gi, "")}` : undefined}>
                  {safeText(t?.text ?? "", 4000)}
                </span>
              ))
            : text}
        </code>
      </pre>
      {footer}
    </div>
  );
}
