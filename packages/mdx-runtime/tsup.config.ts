import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    highlight: "src/highlight/index.ts",
    "highlight-lazy": "src/highlight/lazy.ts",
    format: "src/format.ts",
  },
  format: ["esm"],
  dts: {
    compilerOptions: {
      removeComments: true,
    },
  },
  minify: true,
  clean: true,
  sourcemap: false,
  splitting: true,
  target: "es2022",
  outDir: "dist",
});
