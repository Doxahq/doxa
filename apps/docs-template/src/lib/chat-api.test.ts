import { resolveSiteConfig } from "@doxahq/site-config";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ChatRequestMessage } from "@/src/lib/chat-page-context";

type ChatHandler = (input: {
  data: { messages: ChatRequestMessage[] };
  context?: unknown;
}) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  handler: undefined as ChatHandler | undefined,
  siteConfig: vi.fn(),
  streamDocsChat: vi.fn(async () => new Response("streamed")),
}));

vi.mock("@tanstack/react-start", () => {
  const builder = {
    inputValidator: () => builder,
    handler: (handler: ChatHandler) => {
      mocks.handler = handler;
      return handler;
    },
  };
  return { createServerFn: () => builder };
});

vi.mock("@/src/site-config/request-site-config", () => ({
  requestSiteConfig: mocks.siteConfig,
}));

vi.mock("@/src/lib/chat-stream", () => ({
  streamDocsChat: mocks.streamDocsChat,
}));

await import("./chat-api");

const MESSAGES: ChatRequestMessage[] = [{ role: "user", content: "Hello" }];

function runChat(): Promise<Response> {
  if (!mocks.handler) throw new Error("The chat handler was not registered.");
  return mocks.handler({ data: { messages: MESSAGES } });
}

function enableChat(enabled: boolean) {
  mocks.siteConfig.mockResolvedValue(
    resolveSiteConfig({ name: "Acme", features: { ai: { chat: enabled } } })
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("chatWithDocsStream", () => {
  test("refuses a site that has chat turned off", async () => {
    enableChat(false);

    const response = await runChat();

    expect(response.status).toBe(403);
    expect(mocks.streamDocsChat).not.toHaveBeenCalled();
  });

  test("answers 503 in a build without the template content", async () => {
    enableChat(true);
    vi.stubEnv("DOXA_OMIT_LOCAL_CONTENT_SOURCE", "true");
    vi.stubEnv("AI_API_KEY", "key");

    const response = await runChat();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Chat with Docs is not available for this site.",
    });
    expect(mocks.streamDocsChat).not.toHaveBeenCalled();
  });

  test("streams the answer with the provider key and site name", async () => {
    enableChat(true);
    vi.stubEnv("AI_API_KEY", "key");

    const response = await runChat();

    expect(await response.text()).toBe("streamed");
    expect(mocks.streamDocsChat).toHaveBeenCalledWith(MESSAGES, "key", "Acme");
  });
});
