import { describe, expect, test } from "vitest";

import {
  eagerImportStatements,
  selectEagerChunks,
  type ServerChunk,
} from "./eager-server-chunks";

const CHUNKS: ServerChunk[] = [
  {
    fileName: "index.js",
    isEntry: true,
    moduleIds: ["/app/src/server.ts"],
  },
  {
    fileName: "assets/router-a1.js",
    isEntry: false,
    moduleIds: ["/app/src/routeTree.gen.ts", "/app/src/router.tsx"],
  },
  {
    fileName: "assets/chat-api-b2.js",
    isEntry: false,
    moduleIds: ["/app/src/lib/chat-api.ts?tss-serverfn-split"],
  },
  {
    fileName: "assets/_-c3.js",
    isEntry: false,
    moduleIds: ["/app/src/routes/$.tsx?tsr-split=component"],
  },
];

describe("selectEagerChunks", () => {
  test("selects the chunks that hold a listed module", () => {
    expect(
      selectEagerChunks(CHUNKS, [
        "/src/router.tsx",
        "/src/routes/$.tsx?tsr-split=component",
      ])
    ).toEqual({
      chunks: ["assets/router-a1.js", "assets/_-c3.js"],
      missing: [],
    });
  });

  test("never selects the entry, and reports a module no chunk holds", () => {
    expect(
      selectEagerChunks(CHUNKS, ["/src/server.ts", "/src/routes/gone.tsx"])
    ).toEqual({
      chunks: [],
      missing: ["/src/server.ts", "/src/routes/gone.tsx"],
    });
  });

  test("matches the end of a module ID, not any part of it", () => {
    expect(selectEagerChunks(CHUNKS, ["/src/lib/chat-api.ts"])).toEqual({
      chunks: [],
      missing: ["/src/lib/chat-api.ts"],
    });
  });
});

describe("eagerImportStatements", () => {
  test("imports each chunk relative to the entry", () => {
    expect(
      eagerImportStatements("index.js", [
        "assets/router-a1.js",
        "assets/_-c3.js",
      ])
    ).toBe('import "./assets/router-a1.js";\nimport "./assets/_-c3.js";\n');
  });

  test("walks up from an entry in a folder", () => {
    expect(
      eagerImportStatements("server/index.js", ["assets/router-a1.js"])
    ).toBe('import "../assets/router-a1.js";\n');
  });
});
