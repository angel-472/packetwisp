import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  // Declarations come from `tsc -p tsconfig.build.json` instead: tsup's bundled
  // rollup-plugin-dts targets TypeScript 5.x internals and breaks on TS 7.
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "node20",
});
