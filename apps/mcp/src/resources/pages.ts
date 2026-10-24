import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceNotFoundError,
  ResourceTemplate,
  type Variables,
} from "@modelcontextprotocol/server";
import { editOriginFor } from "@doxahq/api/services/agent-access/actor";
import { DocsContentError } from "@doxahq/api/services/docs-content/errors";
import type { McpRequestContext } from "../request-context";

export const PAGE_RESOURCE_TEMPLATE =
  "doxa://projects/{projectId}/pages/{+href}";
const REQUIRED_SCOPE = "docs:read";

/** The live MDX source of one page: what the published site renders. */
export function registerPageResource(
  server: McpServer,
  context: McpRequestContext,
): void {
  server.registerResource(
    "page",
    new ResourceTemplate(PAGE_RESOURCE_TEMPLATE, { list: undefined }),
    {
      title: "Docs page",
      description:
        "The live MDX source of one published page. Needs the docs:read permission.",
      mimeType: "text/markdown",
      cacheHint: { cacheScope: "private", ttlMs: 0 },
    },
    (uri, variables) => readPage(context, uri, variables),
  );
}

async function readPage(
  context: McpRequestContext,
  uri: URL,
  variables: Variables,
): Promise<ReadResourceResult> {
  const { actor, policy, limiter } = context;
  if (!actor.channel.scopes.has(REQUIRED_SCOPE)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `This connection does not have the ${REQUIRED_SCOPE} permission.`,
    );
  }
  if (!(await limiter.allow("read", actor))) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      "Too many requests from this connection. Wait 60 seconds, then retry.",
    );
  }
  const projectId = singleValue(variables["projectId"]);
  const href = decodeHref(singleValue(variables["href"]));
  if (!projectId || !href) throw new ResourceNotFoundError(uri.href);
  const decision = await policy.authorize(actor, projectId, "docs.read");
  if (!decision.allowed) throw new ResourceNotFoundError(uri.href);
  const page = await readLivePage(
    context,
    decision.project.ownerUserId,
    projectId,
    href,
    uri,
  );
  return {
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: page }],
  };
}

async function readLivePage(
  { actor, services }: McpRequestContext,
  ownerUserId: string,
  projectId: string,
  href: string,
  uri: URL,
): Promise<string> {
  try {
    const page = await services.docs.getPage(
      { userId: ownerUserId, origin: editOriginFor(actor) },
      projectId,
      href,
      "main",
      { published: true },
    );
    return page.publishedContent;
  } catch (error) {
    if (error instanceof DocsContentError && error.code === "not_found") {
      throw new ResourceNotFoundError(uri.href);
    }
    throw error;
  }
}

function singleValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeHref(value: string | null): string | null {
  if (!value || value.length > 500) return null;
  try {
    return decodeURI(value);
  } catch {
    return null;
  }
}
