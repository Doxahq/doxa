import {
  createValidationIssue,
  SITE_ASSET_MAX_BYTES,
  siteAssetKindSchema,
} from "@doxahq/site-config";
import { createApiRouter } from "../http/app";
import { withProjectAccess } from "../http/project-access";
import { readBoundedBody, RequestBodyTooLarge } from "../http/bounded-body";
import { error, json, validationError } from "../http/response";
import { ProjectsRepository } from "../repositories/projects";
import {
  DocsContentError,
  getDocsContentErrorStatus,
} from "../services/docs-content/errors";
import { SiteConfigValidationError } from "../services/site-config-validation";
import { SiteAssetsService } from "../services/site-assets/service";
import { createR2SiteAssetStore } from "../services/site-assets/store";

const MAX_MULTIPART_BYTES = SITE_ASSET_MAX_BYTES.ogImage + 16 * 1024;

export function createSiteAssetsRoutes() {
  const app = createApiRouter();
  app.post("/", (context) =>
    withProjectAccess(context, "site.write", (access) =>
      run(async () => {
        const raw = await readBoundedBody(context.req.raw, MAX_MULTIPART_BYTES);
        let form: FormData;
        try {
          form = await new Response(Uint8Array.from(raw), {
            headers: {
              "content-type": context.req.header("content-type") ?? "",
            },
          }).formData();
        } catch {
          return error(
            "Use a multipart upload with one file and its kind.",
            400,
          );
        }
        const kind = siteAssetKindSchema.safeParse(form.get("kind"));
        const file = form.get("file");
        if (
          !kind.success ||
          !(file instanceof File) ||
          [...form.keys()].length !== 2
        ) {
          return error(
            "Use a multipart upload with one file and its kind.",
            400,
          );
        }
        const service = new SiteAssetsService(
          new ProjectsRepository(context.env),
          createR2SiteAssetStore(context.env.DOCS_BUCKET),
        );
        return json(
          await service.upload(
            access.ownerUserId,
            access.projectId,
            kind.data,
            new Uint8Array(await file.arrayBuffer()),
          ),
          { status: 201 },
        );
      }),
    ),
  );
  app.get("/:hash", (context) =>
    withProjectAccess(context, "docs.read", (access) =>
      run(() => {
        const service = new SiteAssetsService(
          new ProjectsRepository(context.env),
          createR2SiteAssetStore(context.env.DOCS_BUCKET),
        );
        return service.preview(
          access.ownerUserId,
          access.projectId,
          context.req.param("hash"),
        );
      }),
    ),
  );
  return app;
}

async function run(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (cause) {
    if (cause instanceof RequestBodyTooLarge)
      return validationError([
        createValidationIssue("asset_too_large", "", {
          max: SITE_ASSET_MAX_BYTES.ogImage,
        }),
      ]);
    if (cause instanceof SiteConfigValidationError)
      return validationError(cause.issues);
    if (cause instanceof DocsContentError)
      return error(cause.message, getDocsContentErrorStatus(cause.code));
    throw cause;
  }
}
