import {
  addJobEventInputSchema,
  completeJobOutputInputSchema,
  publishJobInputSchema,
} from "@doxahq/contracts";
import { createApiRouter } from "../http/app";
import type { ApiApp } from "../http/app";
import { isInternalHttpAllowed } from "../http/access";
import { parseJson, isResponse } from "../http/body";
import { decodePathSegment } from "../http/path";
import { error, json, notFound } from "../http/response";
import { DocsRepository } from "../repositories/docs";
import { GitHubRepository } from "../repositories/github";
import { JobsRepository } from "../repositories/jobs";
import { ProjectsRepository } from "../repositories/projects";
import { resolveDocsHost } from "../services/docs-host-resolution";
import { parseGenerationPreviewSubdomain } from "../utils/docs-url";
import { withGenerationSiteConfig } from "../services/generation-site-config";
import {
  assertSafeArtifactKey,
  createR2DocsArtifactReader,
} from "../services/docs-content/store";

export function createInternalRoutes(): ApiApp {
  const app = createApiRouter();

  app.use("*", async (context, next) => {
    const isPublicPolicyRequest = context.req.path.startsWith(
      "/internal/docs-access/",
    );
    if (
      !isPublicPolicyRequest &&
      !isInternalHttpAllowed(context.req.raw, context.env)
    ) {
      return notFound();
    }

    await next();
  });

  app.get("/docs-sites/:slug", async (context) => {
    const resolution = await new DocsRepository(context.env).resolveBySlug(context.req.param("slug"));
    if (!resolution) return notFound();
    return json({ site: resolution });
  });

  app.get("/docs-projects/:projectId", async (context) => {
    const resolution = await new DocsRepository(context.env).resolveByProjectId(context.req.param("projectId"));
    if (!resolution) return notFound();
    return json({ site: resolution });
  });

  app.get("/docs-hosts/:hostname", async (context) => {
    const hostname = decodePathSegment(context.req.param("hostname"));
    if (!hostname) return error("Invalid docs hostname.", 400);

    const resolution = await resolveDocsHost(context.env, hostname);
    if (!resolution) return notFound();
    return json({ site: resolution });
  });

  app.get("/docs-access/:hostname", async (context) => {
    const hostname = decodePathSegment(context.req.param("hostname"));
    if (!hostname) return error("Invalid docs hostname.", 400);

    const generationPreview = parseGenerationPreviewSubdomain(
      hostname,
      context.env.DOCS_BASE_DOMAIN,
    );
    const resolution = generationPreview
      ? await resolveDocsHost(context.env, hostname)
      : null;
    return json(
      { policy: resolution?.accessPolicy ?? "authenticated" },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  });

  app.get("/docs-artifacts", async (context) => {
    const artifactPath = context.req.query("path");
    if (!artifactPath) return error("Missing artifact path.", 400);

    const object = await createR2DocsArtifactReader(context.env.DOCS_BUCKET).get(
      assertSafeArtifactKey(artifactPath),
    );
    if (!object) return notFound();

    return new Response(await object.arrayBuffer(), {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/projects/:projectId", async (context) => {
    const project = await new ProjectsRepository(context.env).getInternal(context.req.param("projectId"));
    if (!project) return notFound();
    return json({ project });
  });

  app.get("/projects/:projectId/generation-context", async (context) => {
    const generationContext = await new GitHubRepository(context.env).getGenerationContext(
      context.req.param("projectId"),
    );
    if (!generationContext) return notFound();
    return json({
      context: await withGenerationSiteConfig(context.env, generationContext),
    });
  });

  app.post("/jobs/:jobId/running", async (context) => {
    await new JobsRepository(context.env).markRunning(context.req.param("jobId"));
    return json({ ok: true });
  });

  app.post("/jobs/:jobId/publish", async (context) => {
    const body = await parseJson<unknown>(context.req.raw);
    if (isResponse(body)) return body;

    const input = publishJobInputSchema.safeParse(body);
    if (!input.success) return error("Invalid publish payload.", 400, input.error.flatten());

    const jobId = context.req.param("jobId");
    const version = await new DocsRepository(context.env).publishJob({
      jobId,
      ...input.data,
    });
    return json({ versionId: version.id });
  });

  app.post("/jobs/:jobId/complete", async (context) => {
    const body = await parseJson<unknown>(context.req.raw);
    if (isResponse(body)) return body;

    const input = completeJobOutputInputSchema.safeParse(body);
    if (!input.success) {
      return error(
        "Invalid generation completion payload.",
        400,
        input.error.flatten(),
      );
    }

    const result = await new DocsRepository(
      context.env,
    ).completeJob(
      context.req.param("jobId"),
      input.data,
      context.env,
    );
    return json(result);
  });

  app.post("/jobs/:jobId/events", async (context) => {
    const body = await parseJson<unknown>(context.req.raw);
    if (isResponse(body)) return body;

    const input = addJobEventInputSchema.safeParse(body);
    if (!input.success) return error("Invalid job event payload.", 400, input.error.flatten());

    const event = await new JobsRepository(context.env).addEvent(
      context.req.param("jobId"),
      input.data.type,
      input.data.message,
      input.data.data,
    );
    return json({ event }, { status: 201 });
  });

  app.post("/jobs/:jobId/failed", async (context) => {
    const body = await parseJson<{ message?: string }>(context.req.raw);
    if (isResponse(body)) return body;

    await new JobsRepository(context.env).markFailed(context.req.param("jobId"), body.message ?? "Generation failed.");
    return json({ ok: true });
  });

  return app;
}
