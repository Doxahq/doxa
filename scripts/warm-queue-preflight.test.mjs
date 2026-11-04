import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyQueueInfo,
  describeQueueProblems,
  findQueueProblems,
  listConfiguredQueues,
} from "./lib/warm-queue-preflight.mjs";

const dispatcherConfig = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "..", "apps", "docs-dispatcher", "wrangler.json"),
    "utf8",
  ),
);

test("lists the three warm queues of the dispatcher config", () => {
  assert.deepEqual(listConfiguredQueues(dispatcherConfig), [
    "doxa-docs-warm-dlq",
    "doxa-docs-warm-publish",
    "doxa-docs-warm-sweep",
  ]);
  assert.deepEqual(listConfiguredQueues({}), []);
});

test("classifies wrangler queues info results", () => {
  assert.equal(classifyQueueInfo({ status: 0, output: "Queue Name: x" }), "exists");
  assert.equal(
    classifyQueueInfo({ status: 1, output: 'X [ERROR] Queue "doxa-docs-warm-sweep" does not exist.' }),
    "missing",
  );
  assert.equal(
    classifyQueueInfo({ status: 1, output: "A request to the Cloudflare API failed. [code: 11000]" }),
    "missing",
  );
  assert.equal(
    classifyQueueInfo({ status: 1, output: "Authentication error [code: 10000]" }),
    "unknown",
  );
});

test("finds missing and unchecked queues without side effects", () => {
  const checked = [];
  const problems = findQueueProblems(dispatcherConfig, (name) => {
    checked.push(name);
    if (name === "doxa-docs-warm-publish") return { status: 0, output: "" };
    if (name === "doxa-docs-warm-dlq") return { status: 1, output: "Queue does not exist" };
    return { status: 1, output: "Authentication error" };
  });
  assert.deepEqual(checked, [
    "doxa-docs-warm-dlq",
    "doxa-docs-warm-publish",
    "doxa-docs-warm-sweep",
  ]);
  assert.deepEqual(problems, {
    missing: ["doxa-docs-warm-dlq"],
    unchecked: ["doxa-docs-warm-sweep"],
  });
});

test("passes when every queue exists", () => {
  assert.deepEqual(
    findQueueProblems(dispatcherConfig, () => ({ status: 0, output: "" })),
    { missing: [], unchecked: [] },
  );
});

test("prints the create commands, the dead-letter queue first", () => {
  const message = describeQueueProblems({
    missing: ["doxa-docs-warm-publish", "doxa-docs-warm-dlq"],
    unchecked: [],
  });
  const lines = message.split("\n");
  assert.match(lines[0], /do not exist: doxa-docs-warm-publish, doxa-docs-warm-dlq/);
  assert.equal(lines[2], "  pnpm exec wrangler queues create doxa-docs-warm-dlq");
  assert.equal(lines[3], "  pnpm exec wrangler queues create doxa-docs-warm-publish");
  assert.match(
    describeQueueProblems({ missing: [], unchecked: ["doxa-docs-warm-sweep"] }),
    /Could not check the queues doxa-docs-warm-sweep/,
  );
});
