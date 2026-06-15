import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
  // Bundle everything (ws, zod, @clawdot/protocol) into one file so deploying
  // to the VPS is `scp dist/index.js` — no node_modules needed there.
  noExternal: [/.*/],
  // Optional native accelerators ws try-requires; absent at runtime is fine.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // ws is CJS; give the ESM bundle a require() for its internal use.
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
