import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildRestRequestModel,
  buildRestRequestSample,
  type RestRequestClientId,
} from "../src/doxa-agent/rest-request-samples";
import type { RestApiReferenceEndpoint } from "../src/types";

/**
 * T40 and T41: hostile values from a spec must stay data in every sample a
 * reader copies. No test runs a generated shell or Python sample: the shell
 * sample is split with shlex, and the Python sample is only parsed.
 */
const HOSTILE = `'; touch /tmp/doxa-injected; '$(id)\`whoami\`\${process.exit}"\\ \u0000\nnext`;
const HOSTILE_PATH = "/orders/'$(id)`x`;\"";
const BASE_URL = "https://api.example.com";

const endpoint: RestApiReferenceEndpoint = {
  id: "hostile",
  title: "Hostile values",
  method: "POST",
  path: HOSTILE_PATH,
  description: "",
  parameters: [{ name: "X-Trace", in: "header", type: "string", required: false, example: HOSTILE }],
  bodyFields: [{ name: "note", type: "string", required: true, example: HOSTILE }],
  bodyContentType: "application/json",
  sourceEvidence: [],
};

const model = buildRestRequestModel(endpoint, BASE_URL);
const code = (client: RestRequestClientId) => buildRestRequestSample(client, model).code;
const hasPython = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe("request samples with hostile spec values", () => {
  test.skipIf(!hasPython)("T40 keeps every curl argument one single-quoted word", () => {
    const words: string[] = JSON.parse(execFileSync("python3", [
      "-I",
      "-c",
      "import json, shlex, sys; print(json.dumps(shlex.split(sys.stdin.read().replace('\\\\\\n', ' '))))",
    ], { input: code("curl") }).toString());

    expect(words.slice(0, 4)).toEqual(["curl", "--request", "POST", "--url"]);
    expect(words[4]).toBe(`${BASE_URL}${HOSTILE_PATH}`);
    expect(words).toContain(`X-Trace: ${HOSTILE.replace(/\0/g, "")}`);
    expect(words).toContain("--data");
    expect(JSON.parse(words.at(-1)!)).toEqual({ note: HOSTILE });
  });

  test.each(["node-fetch", "node-xhr"] as const)("T41 keeps %s values as string data", (client) => {
    const calls: unknown[][] = [];
    class FakeXhr {
      open(...args: unknown[]) { calls.push(["open", ...args]); }
      setRequestHeader(...args: unknown[]) { calls.push(["header", ...args]); }
      send(...args: unknown[]) { calls.push(["send", ...args]); }
    }
    const sandbox: Record<string, unknown> = {
      console: { log: () => undefined },
      require: () => FakeXhr,
      fetch: async (...args: unknown[]) => {
        calls.push(args);
        return { json: async () => ({}) };
      },
    };

    const source = client === "node-fetch" ? `(async () => {\n${code(client)}\n})()` : code(client);
    runInNewContext(source, sandbox);

    const flattened = JSON.stringify(calls);
    expect(flattened).toContain(JSON.stringify(`${BASE_URL}${HOSTILE_PATH}`));
    expect(flattened).toContain(JSON.stringify(HOSTILE));
    expect(sandbox.process).toBeUndefined();
  });

  test.skipIf(!hasPython)("T41 keeps Python values as string literals", () => {
    const literals = JSON.parse(execFileSync("python3", [
      "-I",
      "-c",
      [
        "import ast, json, sys",
        "tree = ast.parse(sys.stdin.read())",
        "values = {}",
        "for node in tree.body:",
        "    if isinstance(node, ast.Assign) and isinstance(node.value, (ast.Constant, ast.Dict)):",
        "        values[node.targets[0].id] = ast.literal_eval(node.value)",
        "print(json.dumps(values))",
      ].join("\n"),
    ], { input: code("python-requests") }).toString());

    expect(literals.url).toBe(`${BASE_URL}${HOSTILE_PATH}`);
    expect(literals.headers["X-Trace"]).toBe(HOSTILE);
    expect(literals.payload).toEqual({ note: HOSTILE });
  });

  test("T41 quotes Go strings as JSON string literals", () => {
    const go = code("go");

    expect(go).toContain(`url := ${JSON.stringify(`${BASE_URL}${HOSTILE_PATH}`)}`);
    expect(go).toContain(`req.Header.Set("X-Trace", ${JSON.stringify(HOSTILE)})`);
    expect(go).not.toContain("\u0000");
  });
});
