import { describe, expect, test } from "vitest";

import { runWriterAttempts } from "../src/doxa-agent/writer-pipeline";

/**
 * The writer emits pages in the shared Doxa Markdown style (`formatMdx` from
 * `@doxahq/mdx-runtime/format`), so a page edited later in the dashboard does
 * not change text the editor did not touch.
 */
const modelBody = [
  "## Overview",
  "",
  "This page explains the runtime behavior with enough concrete detail to guide a maintainer.",
  "",
  "* Start the worker",
  "* Open the dashboard",
  "",
  "Read the __full__ guide for *every* option.",
  "",
  "<Card title='Quickstart' href=\"/quickstart\" />",
].join("\n");

function writePage(text: string) {
  return runWriterAttempts({
    title: "Runtime",
    description: "Explain verified runtime behavior for application maintainers.",
    maxAttempts: 1,
    minBodyLength: 20,
    baseTokens: 100,
    expandedTokens: 200,
    validation: { mdxCompile: false },
    runOnce: async () => ({ text }),
    saveDebug: async () => "/tmp/writer-format.md",
  });
}

describe("writer output format", () => {
  test("writes the body in the shared Markdown style", async () => {
    const { content } = await writePage(modelBody);

    expect(content).toContain("- Start the worker\n- Open the dashboard");
    expect(content).toContain("Read the **full** guide for _every_ option.");
    expect(content).not.toContain("* Start the worker");
  });

  test("writes component attributes with double quotes", async () => {
    const { content } = await writePage(modelBody);

    expect(content).toContain('<Card title="Quickstart" href="/quickstart" />');
  });
});
