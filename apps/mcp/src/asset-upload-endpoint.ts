import {
  readBoundedBodyWithin,
  RequestBodyTimeout,
  RequestBodyTooLarge,
} from "@doxahq/api/http/bounded-body";
import {
  AgentAssetUploads,
  type AgentAssetReceiveFailure,
  type BodyReadOutcome,
} from "@doxahq/api/services/docs-branches/assets/agent-asset-uploads";
import {
  AGENT_ASSET_UPLOAD_AUTH_SCHEME,
  AGENT_ASSET_UPLOAD_LIMITS,
  AGENT_ASSET_UPLOAD_PATH,
  DOCS_ASSET_LIMITS,
  type agentAssetUploadReceiptSchema,
} from "@doxahq/contracts/docs-assets";
import type { z } from "zod";
import type { McpEnv } from "./mcp-env";

const MAX_MB = DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024);
const NEW_URL = "Call create_asset_upload for a new upload URL.";

/** `/uploads/{uploadId}`: the upload URL of `create_asset_upload`. */
const UPLOAD_PATH = new RegExp(`^${AGENT_ASSET_UPLOAD_PATH}([0-9a-f-]{36})$`);
/** The secret: base64url of 32 bytes. Anything else is refused unread. */
const AUTHORIZATION = new RegExp(`^${AGENT_ASSET_UPLOAD_AUTH_SCHEME} ([A-Za-z0-9_-]{43})$`);

export function isAssetUploadPath(pathname: string): boolean {
  return pathname.startsWith(AGENT_ASSET_UPLOAD_PATH);
}

type EndpointFailure = AgentAssetReceiveFailure | "unauthorized" | "method_not_allowed";

const FAILURES: Record<EndpointFailure, { status: number; message: string }> = {
  unauthorized: {
    status: 401,
    message: "Send the Authorization header that create_asset_upload returned with this URL.",
  },
  method_not_allowed: { status: 405, message: "Send the file with an HTTP PUT." },
  not_found: { status: 404, message: `This upload URL or its Authorization header is not valid. ${NEW_URL}` },
  expired: { status: 410, message: `This upload URL expired. ${NEW_URL}` },
  closed: {
    status: 410,
    message: `This upload URL refused ${AGENT_ASSET_UPLOAD_LIMITS.maxFailedAttempts} files and is closed. ${NEW_URL}`,
  },
  already_received: {
    status: 409,
    message: "This URL already has its file. Call finish_asset_upload, or create a new upload URL for another file.",
  },
  conflict: {
    status: 409,
    message: "Another request to this URL changed it at the same time. Send the file again.",
  },
  too_large: {
    status: 413,
    message: `An image can have at most ${MAX_MB} MB. Resize or compress it, then send it to this URL again.`,
  },
  timed_out: {
    status: 408,
    message: `The file did not arrive within ${AGENT_ASSET_UPLOAD_LIMITS.bodyTimeoutSeconds} seconds. Send it again.`,
  },
  not_an_image: {
    status: 415,
    message: "The file is not a PNG, JPEG, WebP, GIF, or SVG image. Nothing was stored. Send an image file to this URL.",
  },
  empty: {
    status: 400,
    message: "The request body is empty. Send the file bytes as the PUT body, for example with curl --data-binary @FILE.",
  },
};

/**
 * Receives the file of an MCP upload URL. The secret in the Authorization
 * header is the only credential, like an S3 presigned URL, so the route
 * runs before OAuth. The URL path holds no secret, so request logs never
 * record one. The handler checks the request before it reads the body,
 * reads at most the image limit within the body deadline, and only stages
 * the bytes: `finish_asset_upload` adds the image to the branch.
 */
export async function handleAssetUpload(
  request: Request,
  env: McpEnv,
  uploads: Pick<AgentAssetUploads, "receive"> = AgentAssetUploads.receiverFor(env.DOCS_BUCKET),
): Promise<Response> {
  const uploadId = UPLOAD_PATH.exec(new URL(request.url).pathname)?.[1];
  if (!uploadId) return failure("not_found");
  if (request.method !== "PUT") return failure("method_not_allowed", { allow: "PUT" });
  const secret = AUTHORIZATION.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!secret) {
    return failure("unauthorized", { "www-authenticate": AGENT_ASSET_UPLOAD_AUTH_SCHEME });
  }

  const result = await uploads.receive(uploadId, secret, (maxBytes) => readBody(request, maxBytes));
  if (!result.ok) return failure(result.reason);
  const receipt: z.infer<typeof agentAssetUploadReceiptSchema> = {
    uploadId,
    size: result.size,
    next: `Call finish_asset_upload with uploadId ${uploadId} to add the image to the branch.`,
  };
  return json(receipt, 200);
}

async function readBody(request: Request, maxBytes: number): Promise<BodyReadOutcome> {
  try {
    const bytes = await readBoundedBodyWithin(
      request,
      maxBytes,
      AGENT_ASSET_UPLOAD_LIMITS.bodyTimeoutSeconds * 1000,
    );
    return { kind: "body", bytes };
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) return { kind: "too_large" };
    if (error instanceof RequestBodyTimeout) return { kind: "timed_out" };
    throw error;
  }
}

function failure(reason: EndpointFailure, headers: Record<string, string> = {}): Response {
  const { status, message } = FAILURES[reason];
  return json({ error: reason, message }, status, headers);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}
