import {
  AGENT_ASSET_UPLOAD_LIMITS,
  DOCS_ASSET_LIMITS,
  agentAssetUploadTicketSchema,
} from "@doxahq/contracts/docs-assets";
import { z } from "zod";
import { defineMcpTool } from "../../tool-definition";
import { agentIdentity } from "../branches/branch-view";
import { OWN_BRANCH_ONLY, requireOwnBranch } from "../branches/branch-ownership";
import { namedBranchInput, projectIdInput, writeAnnotations } from "../shared";

const MAX_MB = DOCS_ASSET_LIMITS.maxBytes / (1024 * 1024);
const TTL_MINUTES = AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds / 60;
const MAX_OPEN = AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerConnection;
const MAX_FAILURES = AGENT_ASSET_UPLOAD_LIMITS.maxFailedAttempts;

/**
 * Single quotes keep the shell from reading the values; both hold only
 * URL and base64url characters, so neither can close a quote.
 */
function curlCommand(uploadUrl: string, authorization: string): string {
  return `curl -sS -X PUT -H 'Authorization: ${authorization}' --data-binary @FILE '${uploadUrl}'`;
}

export const createAssetUploadTool = defineMcpTool({
  name: "create_asset_upload",
  title: "Create image upload URL",
  description: `Starts an image upload for a file on your machine, of any size up to ${MAX_MB} MB. This is the way to add an image when you can run a shell command; the file bytes never go through a tool call. Steps: 1) Call this tool. 2) Send the raw file bytes to uploadUrl with one HTTP PUT and the returned Authorization header: run the returned curl command with FILE replaced by the image path. The response is JSON with the received size. 3) Call finish_asset_upload with uploadId; it returns the path to use in MDX. The URL accepts one image file and expires after ${TTL_MINUTES} minutes. Accepted types: PNG, JPEG, WebP, GIF, SVG; the type comes from the bytes, and the PUT refuses any other file with HTTP 415. After ${MAX_FAILURES} refused files the URL closes. A connection can hold ${MAX_OPEN} open upload URLs at once: finish each upload before you start more. The Authorization value is a secret: never put it in a page, a file, or a message. If you cannot run commands, use upload_asset for a small image instead. ${OWN_BRANCH_ONLY}`,
  scope: "docs:write",
  // Expensive: each URL can hold a staged file until it expires.
  cost: "expensive",
  annotations: writeAnnotations(false),
  input: z
    .object({
      projectId: projectIdInput,
      branch: namedBranchInput,
      fileName: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "A file name such as rate-limits-diagram.png. It becomes a lowercase slug.",
        ),
    })
    .strict(),
  output: agentAssetUploadTicketSchema,
  async run(context, input) {
    const authorized = await context.authorize(input.projectId, "docs.write");
    const branchId = await requireOwnBranch(context, authorized, input.branch);
    const created = await context.services.assetUploads.create({
      ownerUserId: authorized.ownerUserId,
      projectId: authorized.projectId,
      branchId,
      agent: agentIdentity(context.actor),
      fileName: input.fileName,
    });
    return {
      uploadId: created.uploadId,
      uploadUrl: created.uploadUrl,
      method: "PUT" as const,
      headers: { Authorization: created.authorization },
      maxBytes: DOCS_ASSET_LIMITS.maxBytes,
      expiresAt: created.expiresAt,
      curl: curlCommand(created.uploadUrl, created.authorization),
    };
  },
});
