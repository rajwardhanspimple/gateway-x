// One-off codemod for the visual-consistency review pass.
// Maps every text size onto the fixed type scale and every radius onto the
// radius scale inside flim.css, and bumps sub-12px readable text to >=12px.
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../src/styles/flim.css", import.meta.url);
let s = readFileSync(file, "utf8");
let n = 0;
const rep = (from, to) => {
  const before = s;
  s = s.split(from).join(to);
  if (s !== before) n++;
};

/* ---- radius scale: only 4 / 8 / 16 (+ pill 999 / circle 50%) survive ---- */
rep("border-radius: 5px;", "border-radius: var(--r-sm);");
rep("border-radius: 6px;", "border-radius: var(--r-sm);");
rep("border-radius: 7px;", "border-radius: var(--r-sm);");
rep("border-radius: 8px;", "border-radius: var(--r-md);");
rep("border-radius: 9px;", "border-radius: var(--r-md);");
rep("border-radius: 10px;", "border-radius: var(--r-md);");
rep("border-radius: 11px;", "border-radius: var(--r-md);");
rep("border-radius: 12px;", "border-radius: var(--r-lg);");
rep("border-radius: 14px;", "border-radius: var(--r-lg);");

/* ---- type scale: 12 / 14 / 16 / 20 / 24 / 32 ---------------------------- */
/* non-scale sizes round to the nearest scale step */
rep("font-size: 13px;", "font-size: var(--fs-sm);");
rep("font-size: 12.5px;", "font-size: var(--fs-xs);");
rep("font-size: 11.5px;", "font-size: var(--fs-xs);");
rep("font-size: 15px;", "font-size: var(--fs-base);");
/* on-scale sizes use the token instead of a literal */
rep("font-size: 16px;", "font-size: var(--fs-base);");
rep("font-size: 14px;", "font-size: var(--fs-sm);");
rep("font-size: 12px;", "font-size: var(--fs-xs);");
/* readable text never drops below 12px — short labels/badges go to --fs-xs */
rep("font-size: 11px;", "font-size: var(--fs-xs);");
rep("font-size: 10px;", "font-size: var(--fs-xs);");
rep("font-size: 9.5px;", "font-size: var(--fs-xs);");
rep("font-size: 9px;", "font-size: var(--fs-xs);");

writeFileSync(file, s);
console.log(`flim.css visual pass applied (${n} substitution groups hit)`);
