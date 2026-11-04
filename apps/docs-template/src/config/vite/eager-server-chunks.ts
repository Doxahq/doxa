import { posix } from "node:path";

import type { Plugin } from "vite";

/**
 * Modules that every page render of the platform renderer loads. Each entry
 * is the end of a Rollup module ID.
 *
 * The bundler gives them their own chunks behind dynamic imports, so a
 * Dynamic Worker compiles them only on the first render, and V8's code cache
 * of the isolate start does not cover them. `eagerServerChunksPlugin` makes
 * the server entry import their chunks.
 *
 * Leave out what only some pages or requests use: chat, search, the full
 * Lucide set, API reference bodies, diagrams, and the code grammars.
 */
export const PAGE_RENDER_MODULES: readonly string[] = [
  "/src/router.tsx",
  "/src/routes/$.tsx?tsr-split=component",
  "/src/routes/index.tsx?tsr-split=component",
  "/src/runtime/runtime-route-data.ts?tss-serverfn-split",
  "/src/site-config/root-site-config.ts?tss-serverfn-split",
  "/src/runtime/server-highlighter.ts",
  "tanstack-start-manifest:v",
  "/@tanstack/react-start/dist/plugin/default-entry/start.ts",
  "/@tanstack/start-server-core/dist/esm/empty-plugin-adapters.js",
  "/@shikijs/themes/dist/github-light.mjs",
  "/@shikijs/themes/dist/github-dark.mjs",
];

export interface ServerChunk {
  fileName: string;
  isEntry: boolean;
  moduleIds: readonly string[];
}

export interface EagerChunkSelection {
  /** File names of the chunks the entry should import. */
  chunks: string[];
  /** Module ID endings that no chunk contains. */
  missing: string[];
}

/** The non-entry chunks that contain one of the given modules. */
export function selectEagerChunks(
  chunks: readonly ServerChunk[],
  modules: readonly string[]
): EagerChunkSelection {
  const found = new Set<string>();
  const selected: string[] = [];

  for (const chunk of chunks) {
    if (chunk.isEntry) continue;
    const matches = modules.filter((module) =>
      chunk.moduleIds.some((id) => id.endsWith(module))
    );
    for (const module of matches) found.add(module);
    if (matches.length > 0) selected.push(chunk.fileName);
  }

  return {
    chunks: selected,
    missing: modules.filter((module) => !found.has(module)),
  };
}

/** Side-effect imports of `chunks`, relative to the entry file. */
export function eagerImportStatements(
  entryFileName: string,
  chunks: readonly string[]
): string {
  const entryDirectory = posix.dirname(entryFileName);
  return chunks
    .map((chunk) => {
      const path = posix.relative(entryDirectory, chunk);
      return `import ${JSON.stringify(path.startsWith(".") ? path : `./${path}`)};\n`;
    })
    .join("");
}

/**
 * Makes the server entry import the chunks of `PAGE_RENDER_MODULES`, so they
 * are part of the startup module graph. Only for the server build of the
 * platform renderer: the client keeps its code splitting.
 *
 * The build fails when a listed module is in no chunk, so a renamed route
 * cannot silently drop out of the startup graph.
 */
export function eagerServerChunksPlugin(
  modules: readonly string[] = PAGE_RENDER_MODULES
): Plugin {
  return {
    name: "doxa:eager-server-chunks",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk"
      );
      const entries = chunks.filter((chunk) => chunk.isEntry);
      if (entries.length !== 1) {
        this.error(`Expected one server entry chunk, found ${entries.length}.`);
      }
      const [entry] = entries;

      const selection = selectEagerChunks(
        chunks.map((chunk) => ({
          fileName: chunk.fileName,
          isEntry: chunk.isEntry,
          moduleIds: chunk.moduleIds,
        })),
        modules
      );
      if (selection.missing.length > 0) {
        this.error(
          `These page render modules are in no server chunk: ${selection.missing.join(", ")}. Update PAGE_RENDER_MODULES.`
        );
      }

      entry.code =
        eagerImportStatements(entry.fileName, selection.chunks) + entry.code;
    },
  };
}
