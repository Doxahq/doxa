import { requestSiteConfig } from "@/src/site-config/request-site-config";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const chatPageContextSchema = z.object({
  slug: z.string().min(1),
  href: z.string().min(1),
  sourcePath: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});

const chatRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      pageContext: chatPageContextSchema.optional().catch(undefined),
    })
  ),
});

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const chatWithDocsStream = createServerFn({ method: "POST" })
  .inputValidator((data) => chatRequestSchema.parse(data))
  .handler(async ({ data, context }): Promise<Response> => {
    const config = await requestSiteConfig(context ?? {});
    console.log(
      "[chat-api-stream] Handler invoked, messages:",
      data.messages.length
    );
    if (!config.features.ai.chat) {
      return jsonError("Chat with Docs is disabled.", 403);
    }

    // The assistant reads the template's own content (`contentStore`). The
    // platform renderer serves published sites without that content, so its
    // build leaves the assistant and the AI provider SDKs out.
    if (import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE) {
      return jsonError("Chat with Docs is not available for this site.", 503);
    }

    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) {
      return jsonError("AI_API_KEY environment variable is not set.", 500);
    }

    const { messages } = data;

    if (messages.length > 50) {
      return jsonError("Too many messages.", 400);
    }

    const { streamDocsChat } = await import("@/src/lib/chat-stream");
    return streamDocsChat(messages, apiKey, config.name);
  });
