/* Registers the render-test module hooks. Loaded with `node --import`. */
import { register } from "node:module"

register(new URL("./loader.mjs", import.meta.url), {
  parentURL: import.meta.url,
  data: {
    root: process.env.RENDER_ROOT || process.cwd(),
    transform: process.env.RENDER_TRANSFORM || "none",
  },
})
