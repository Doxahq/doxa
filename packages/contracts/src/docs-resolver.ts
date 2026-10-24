import { z } from "zod";
import {
  docsDomainResolutionSchema,
  docsHostResolutionSchema,
  type DocsDomainResolution,
  type DocsHostResolution,
  type InternalApiRpc,
} from "./index";

export const docsResolverRequestSchema = z
  .object({
    kind: z.enum(["host", "project", "slug"]),
    value: z.string().trim().min(1).max(253),
  })
  .strict();

export type DocsResolverRequest = z.infer<typeof docsResolverRequestSchema>;
export type DocsResolver = Pick<
  InternalApiRpc,
  "resolveDocsHost" | "resolveDocsProject" | "resolveDocsSite"
>;

/** A default-fetch service binding, never a public URL or named RPC entrypoint. */
export interface DocsResolverBinding {
  fetch(request: Request): Promise<Response>;
}

export class DocsResolverClient implements DocsResolver {
  constructor(private readonly binding: DocsResolverBinding) {}

  resolveDocsHost(hostname: string): Promise<DocsDomainResolution | null> {
    return this.resolve(
      { kind: "host", value: hostname },
      docsDomainResolutionSchema,
    );
  }

  resolveDocsProject(projectId: string): Promise<DocsHostResolution | null> {
    return this.resolve(
      { kind: "project", value: projectId },
      docsHostResolutionSchema,
    );
  }

  resolveDocsSite(projectSlug: string): Promise<DocsHostResolution | null> {
    return this.resolve(
      { kind: "slug", value: projectSlug },
      docsHostResolutionSchema,
    );
  }

  private async resolve<T>(
    input: DocsResolverRequest,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const response = await this.binding.fetch(
      new Request("https://docs-resolver.internal/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(docsResolverRequestSchema.parse(input)),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Docs resolver request failed (HTTP ${response.status}).`,
      );
    }
    const payload: unknown = await response.json();
    return z.object({ resolution: schema.nullable() }).strict().parse(payload)
      .resolution;
  }
}
