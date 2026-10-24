import { describe, expect, test } from "vitest";
import { runJobMain } from "../src/job-main";
import { jobFailure, jobSuccess } from "../src/outcome";

async function* stdinOf(...chunks: string[]): AsyncIterable<string> {
  yield* chunks;
}

function capture() {
  const written: string[] = [];
  return { written, stdout: { write: (text: string) => written.push(text) } };
}

describe("job entry", () => {
  test("runs the handler once on the whole input", async () => {
    const output = capture();

    await runJobMain(
      (input) => jobSuccess(new TextDecoder().decode(input).toUpperCase()),
      { stdin: stdinOf("ab", "cd"), stdout: output.stdout },
    );

    expect(output.written).toEqual([JSON.stringify(jobSuccess("ABCD"))]);
  });

  test("returns a failure that the handler chose", async () => {
    const output = capture();

    await runJobMain(() => jobFailure("invalid_input", "No roots."), { stdin: stdinOf(), stdout: output.stdout });

    expect(JSON.parse(output.written[0]!)).toEqual(jobFailure("invalid_input", "No roots."));
  });

  test("reports a thrown error by its name only, never by its message", async () => {
    const output = capture();

    await runJobMain(() => {
      throw new SyntaxError("Unexpected token near: secret-token-from-the-input");
    }, { stdin: stdinOf("x"), stdout: output.stdout });

    expect(output.written[0]).not.toContain("secret");
    expect(JSON.parse(output.written[0]!)).toEqual(jobFailure("job_failed", "The job failed with SyntaxError."));
  });
});
