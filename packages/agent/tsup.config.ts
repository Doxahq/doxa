import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/adapters/node.ts",
    structure: "src/structure.ts",
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
  splitting: false,
  target: "es2022",
  outDir: "dist",
  noExternal: ["@doxahq/contracts"],
});
