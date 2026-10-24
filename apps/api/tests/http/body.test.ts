import { describe, expect, test } from "vitest";
import { z } from "zod";
import { isResponse, parseJson, readValidBody } from "../../src/http/body";

describe("parseJson", () => {
  test("returns parsed JSON bodies", async () => {
    const parsed = await parseJson<{ ok: boolean }>(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
      }),
    );

    expect(parsed).toEqual({ ok: true });
  });

  test("returns a 400 response for invalid JSON", async () => {
    const parsed = await parseJson(
      new Request("http://localhost", {
        method: "POST",
        body: "{",
      }),
    );

    expect(isResponse(parsed)).toBe(true);
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });
});

describe("readValidBody", () => {
  const schema = z.object({ note: z.string().optional() }).strict();
  const post = (body: string) => new Request("http://localhost", { method: "POST", body });

  test("returns the parsed body when it matches", async () => {
    await expect(readValidBody(post('{"note":"hi"}'), schema)).resolves.toEqual({ note: "hi" });
  });

  test("returns null for invalid JSON or a body that does not match", async () => {
    await expect(readValidBody(post("{"), schema)).resolves.toBeNull();
    await expect(readValidBody(post('{"other":1}'), schema)).resolves.toBeNull();
  });

  test("reads an empty body as {} only when the body is optional", async () => {
    await expect(readValidBody(post(""), schema)).resolves.toBeNull();
    await expect(readValidBody(post("  "), schema, { optional: true })).resolves.toEqual({});
  });
});
