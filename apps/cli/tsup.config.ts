import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
  // Bundle the workspace dep so the package installs standalone
  // (npm i -g ./apps/cli, and later npm publish). @clawdot/protocol is a
  // devDependency for exactly this reason; registry deps stay external.
  noExternal: ["@clawdot/protocol"],
});
