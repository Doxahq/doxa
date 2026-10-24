import { createServer } from "node:http";
import { describe, expect, test } from "vitest";
import { startContainerServer } from "../src/startup";

describe("agent container startup", () => {
  test("does not create or listen on the server when runtime preflight fails", async () => {
    let serverCreated = false;

    await expect(startContainerServer({
      port: 0,
      preflight: async () => {
        throw new Error("missing MDX runtime dependency");
      },
      createServer: () => {
        serverCreated = true;
        return createServer();
      },
    })).rejects.toThrow("missing MDX runtime dependency");

    expect(serverCreated).toBe(false);
  });
});
