import {
  branchIdSchema,
  branchRefSchema,
  createDocsBranchInputSchema,
  docsBranchPageDiffQuerySchema,
  docsConflictDiffQuerySchema,
  publishDocsBranchInputSchema,
  renameDocsBranchInputSchema,
  syncDocsBranchInputSchema,
  validateBranchName,
  type DocsPublishStage,
} from "@doxahq/contracts/docs-branches";
import {
  DOCS_ASSET_LIMITS,
  docsAssetFileNameSchema,
} from "@doxahq/contracts/docs-assets";
import type { ValidationIssue } from "@doxahq/contracts/validation";
import { createApiRouter, type ApiApp, type ApiContext } from "../http/app";
import {
  withProjectAccess,
  type DashboardProjectAccess,
} from "../http/project-access";
import { isResponse, parseJson } from "../http/body";
import { readClientWarmPool } from "../http/client-region";
import { readBoundedBody, RequestBodyTooLarge } from "../http/bounded-body";
import { toSafeErrorLog } from "../http/error-log";
import { acceptsEventStream, streamProgress } from "../http/progress-stream";
import { error, json, notFound, validationError } from "../http/response";
import { DocsBranchAssetRead } from "../services/docs-branches/assets/asset-read";
import { DocsBranchAssetUpload } from "../services/docs-branches/assets/asset-upload";
import { DocsBranchDiffService } from "../services/docs-branches/branch-diff";
import { DocsBranchService } from "../services/docs-branches/branch-service";
import { DocsBranchValidationError } from "../services/docs-branches/management";
import { DocsBranchPublish } from "../services/docs-branches/publish";
import { DocsBranchPreview } from "../services/docs-branches/preview";
import { DocsBranchStatusRepository } from "../repositories/docs-branch-status";
import { SyncValidationError } from "../services/docs-branches/sync";
import { SiteConfigValidationError } from "../services/site-config-validation";
import {
  DocsContentError,
  getDocsContentErrorStatus,
} from "../services/docs-content/errors";

/**
 * Each handler authorizes the session user through the project access policy
 * and passes the project owner's ID to the owner-scoped branch services.
 */
export function createDocsBranchRoutes(): ApiApp {
  const app = createApiRouter();

  app.get("/", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      listDocsBranches(context, access),
    ),
  );
  app.post("/", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const projectId = context.req.param("projectId");

        if (!projectId) {
          return notFound();
        }

        const body = await parseJson<unknown>(context.req.raw);

        if (isResponse(body)) {
          return body;
        }

        const nameIssues = validateBranchName(readBranchName(body));

        if (nameIssues.length > 0) {
          return branchValidationError(nameIssues);
        }

        const parsed = createDocsBranchInputSchema.safeParse(body);

        if (!parsed.success) {
          return error("Invalid branch creation request.", 400);
        }

        const branch = await DocsBranchService.fromEnv(context.env).create({
          userId,
          projectId,
          request: parsed.data,
        });

        return json(branch, { status: 201 });
      }),
    ),
  );
  app.patch("/:branchRef", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = namedBranchTarget(context);

        if (!target) {
          return notFound();
        }

        const body = await parseJson<unknown>(context.req.raw);

        if (isResponse(body)) {
          return body;
        }

        const nameIssues = validateBranchName(readBranchName(body));

        if (nameIssues.length > 0) {
          return branchValidationError(nameIssues);
        }

        const parsed = renameDocsBranchInputSchema.safeParse(body);

        if (!parsed.success) {
          return error("Invalid branch rename request.", 400);
        }

        const branch = await DocsBranchService.fromEnv(context.env).rename({
          userId,
          ...target,
          request: parsed.data,
        });

        return json(branch);
      }),
    ),
  );
  app.delete("/:branchRef", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = namedBranchTarget(context);

        if (!target) {
          return notFound();
        }

        if ((await context.req.text()).trim().length > 0) {
          return error("Invalid branch erase request.", 400);
        }

        await DocsBranchService.fromEnv(context.env).erase({
          actor: { userId, origin: "editor" },
          ...target,
        });

        return new Response(null, { status: 204 });
      }),
    ),
  );

  app.get("/:branchRef/status", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const status = await new DocsBranchStatusRepository(context.env).get({
          userId,
          ...target,
        });

        return json(status);
      }),
    ),
  );
  app.get("/:branchRef/sync", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const preview = await DocsBranchService.fromEnv(
          context.env,
        ).previewSync({
          userId,
          ...target,
        });

        return json(preview);
      }),
    ),
  );
  app.get("/:branchRef/sync/diff", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const query = docsConflictDiffQuerySchema.safeParse({
          key: new URL(context.req.url).searchParams.get("key"),
        });

        if (!query.success) {
          return error("A valid conflict key is required.", 400);
        }

        const diff = await DocsBranchService.fromEnv(context.env).diffSync({
          userId,
          ...target,
          key: query.data.key,
        });

        return json(diff);
      }),
    ),
  );
  app.get("/:branchRef/diff", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const diff = await DocsBranchDiffService.fromEnv(context.env).diff({
          userId,
          ...target,
        });

        return json(diff);
      }),
    ),
  );
  app.get("/:branchRef/diff/page", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const query = docsBranchPageDiffQuerySchema.safeParse({
          href: new URL(context.req.url).searchParams.get("href"),
        });

        if (!query.success) {
          return error("A valid page href is required.", 400);
        }

        const sources = await DocsBranchDiffService.fromEnv(
          context.env,
        ).pageSources({ userId, ...target, href: query.data.href });

        return json(sources);
      }),
    ),
  );
  app.post("/:branchRef/sync", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const body = await parseJson<unknown>(context.req.raw);

        if (isResponse(body)) {
          return body;
        }

        const parsed = syncDocsBranchInputSchema.safeParse(body);

        if (!parsed.success) {
          return error("Invalid synchronization request.", 400);
        }

        const result = await DocsBranchService.fromEnv(context.env).synchronize(
          {
            userId,
            ...target,
            request: parsed.data,
          },
        );

        return json(result);
      }),
    ),
  );
  app.post("/:branchRef/publish", (context) =>
    withProjectAccess(context, "docs.publish", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const body = await parseJson<unknown>(context.req.raw);

        if (isResponse(body)) {
          return body;
        }

        const parsed = publishDocsBranchInputSchema.safeParse(body);

        if (!parsed.success) {
          return error("Invalid publish request.", 400);
        }

        const publisher = DocsBranchPublish.fromEnv(context.env);
        const warmRegion = readClientWarmPool(context.req.raw);
        const input = {
          userId,
          ...target,
          request: parsed.data,
          ...(warmRegion ? { warmRegion } : {}),
        };

        if (!acceptsEventStream(context.req.raw)) {
          return json(await publisher.publish(input));
        }

        return streamProgress(
          context,
          (onStage: (stage: DocsPublishStage) => void) => publisher.publish({ ...input, onStage }),
          publishErrorResponse,
        );
      }),
    ),
  );
  app.post("/:branchRef/preview", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        if ((await context.req.text()).trim().length > 0) {
          return error("Invalid branch preview request.", 400);
        }

        const result = await DocsBranchPreview.fromEnv(context.env).build({
          userId,
          ...target,
        });

        return json(result);
      }),
    ),
  );
  app.post("/:branchRef/discard", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const projectId = context.req.param("projectId");
        const parsed = branchRefSchema.safeParse(
          context.req.param("branchRef"),
        );

        if (!projectId || !parsed.success) {
          return notFound();
        }

        const result = await DocsBranchService.fromEnv(context.env).discard({
          actor: { userId, origin: "editor" },
          projectId,
          branch: parsed.data,
        });

        return json(result);
      }),
    ),
  );
  app.post("/:branchRef/assets", (context) =>
    withProjectAccess(context, "docs.write", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);

        if (!target) {
          return notFound();
        }

        const file = await readAssetUpload(context.req.raw);

        if (isResponse(file)) {
          return file;
        }

        const uploaded = await DocsBranchAssetUpload.fromEnv(
          context.env,
        ).upload({
          userId,
          ...target,
          origin: "editor",
          fileName: file.name,
          bytes: file.bytes,
        });
        return json(uploaded, { status: 201 });
      }),
    ),
  );
  app.get("/:branchRef/assets/:name", (context) =>
    withProjectAccess(context, "docs.read", ({ ownerUserId: userId }) =>
      run(async () => {
        const target = branchTarget(context);
        const name = docsAssetFileNameSchema.safeParse(
          context.req.param("name"),
        );

        if (!target || !name.success) {
          return notFound();
        }

        const file = await DocsBranchAssetRead.fromEnv(context.env).read({
          userId,
          ...target,
          name: name.data,
        });

        if (!file) {
          return notFound();
        }

        const headers = new Headers({
          "Content-Type": file.contentType,
          // A branch can replace the file behind a name at any edit.
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        if (file.contentType === "image/svg+xml") {
          headers.set(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          );
        }
        return new Response(new Uint8Array(file.bytes), { headers });
      }),
    ),
  );
  return app;
}

/** Room for the multipart boundary and headers around the file. */
const ASSET_UPLOAD_OVERHEAD_BYTES = 64 * 1024;

/**
 * One image in a multipart body under the field `file`. The type comes from
 * the bytes later, so the browser's MIME type is ignored here.
 */
async function readAssetUpload(
  request: Request,
): Promise<{ name: string; bytes: Uint8Array } | Response> {
  let raw: Uint8Array;
  try {
    raw = await readBoundedBody(
      request,
      DOCS_ASSET_LIMITS.maxBytes + ASSET_UPLOAD_OVERHEAD_BYTES,
    );
  } catch (cause) {
    if (!(cause instanceof RequestBodyTooLarge)) throw cause;
    throw new DocsContentError(
      "asset_too_large",
      `An image can be at most ${DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024)} MB.`,
      { maxBytes: DOCS_ASSET_LIMITS.maxBytes },
    );
  }

  let form: FormData;
  try {
    form = await new Response(Uint8Array.from(raw), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return error("Use a multipart upload with one file.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File) || [...form.keys()].length !== 1) {
    return error("Use a multipart upload with one file.", 400);
  }
  return {
    name: file.name || "image",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

function branchTarget(context: {
  req: { param(name: string): string | undefined };
}) {
  const projectId = context.req.param("projectId");
  const parsed = branchRefSchema.safeParse(context.req.param("branchRef"));
  return projectId && parsed.success
    ? { projectId, branch: parsed.data }
    : null;
}

function namedBranchTarget(context: {
  req: { param(name: string): string | undefined };
}) {
  const projectId = context.req.param("projectId");
  const branchId = branchIdSchema.safeParse(context.req.param("branchRef"));

  return projectId && branchId.success
    ? { projectId, branchId: branchId.data }
    : null;
}

function readBranchName(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }

  return Reflect.get(body, "name");
}

/** `GET /projects/:projectId/branches`, after `docs.read` passed. */
export function listDocsBranches(
  context: ApiContext,
  { ownerUserId: userId }: DashboardProjectAccess,
): Promise<Response> {
  return run(async () => {
    const projectId = context.req.param("projectId");

    if (!projectId) {
      return notFound();
    }

    const branches = await DocsBranchService.fromEnv(context.env).list({
      userId,
      projectId,
    });

    return json(branches);
  });
}

async function run(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    const response = knownErrorResponse(cause);

    if (response) {
      return response;
    }

    throw cause;
  }
}

/** The response for an expected failure, or null for an unexpected one. */
function knownErrorResponse(cause: unknown): Response | null {
  if (cause instanceof DocsBranchValidationError) {
    return branchValidationError(cause.issues);
  }

  if (
    cause instanceof SyncValidationError ||
    cause instanceof SiteConfigValidationError
  ) {
    return validationError(cause.issues);
  }

  if (cause instanceof DocsContentError) {
    return error(cause.message, getDocsContentErrorStatus(cause.code), {
      code: cause.code,
      ...(cause.details && typeof cause.details === "object"
        ? cause.details
        : {}),
    });
  }

  return null;
}

/** The error response for a failed publish, logged when it was unexpected. */
function publishErrorResponse(cause: unknown): Response {
  const response = knownErrorResponse(cause);
  if (response) return response;
  console.error("Unhandled request error.", toSafeErrorLog(cause));
  return error("Internal server error.", 500);
}

function branchValidationError(issues: readonly ValidationIssue[]): Response {
  return validationError(issues, "The branch request has validation errors.");
}
