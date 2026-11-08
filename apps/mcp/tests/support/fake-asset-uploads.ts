import { createMemoryR2Bucket } from "@doxahq/api/tests/support/memory-r2-bucket";
import { AgentAssetUploads } from "@doxahq/api/services/docs-branches/assets/agent-asset-uploads";
import type { AgentAssetUploadResource } from "@doxahq/contracts/storage-gc";
import { createR2AgentUploadStore } from "@doxahq/api/services/docs-branches/assets/agent-upload-store";
import type { AssetUploadServices } from "../../src/services/mcp-services";

export const UPLOAD_ORIGIN = "http://localhost:8791";

export interface FakeAssetUploads {
  /** The real staging logic over an in-memory bucket. */
  uploads: AgentAssetUploads;
  bucket: R2Bucket;
  registered: AgentAssetUploadResource[];
  /** Moves the staging clock, for expiry tests. */
  advance(ms: number): void;
}

export function createFakeAssetUploads(): FakeAssetUploads {
  const { bucket } = createMemoryR2Bucket();
  const registered: AgentAssetUploadResource[] = [];
  let offset = 0;
  const uploads = new AgentAssetUploads({
    store: createR2AgentUploadStore(bucket),
    registerUpload: async (resource) => void registered.push(resource),
    now: () => new Date(Date.now() + offset),
  });
  return {
    uploads,
    bucket,
    registered,
    advance: (ms) => {
      offset += ms;
    },
  };
}

/** The production wrapper of `createMcpServices`, over the fake store. */
export function assetUploadServices(
  fake: FakeAssetUploads,
  record: (method: string, userId: string | null, projectId: string | null) => void = () => {},
): AssetUploadServices {
  return {
    async create(input) {
      record("assetUploads.create", input.ownerUserId, input.projectId);
      const created = await fake.uploads.create(input);
      return {
        uploadId: created.uploadId,
        uploadUrl: `${UPLOAD_ORIGIN}/uploads/${created.uploadId}`,
        authorization: `Bearer ${created.secret}`,
        expiresAt: created.expiresAt,
      };
    },
    takeFor: (uploadId, owner) => fake.uploads.takeFor(uploadId, owner),
    async discard(ticket) {
      record("assetUploads.discard", ticket.ownerUserId, ticket.projectId);
      await fake.uploads.discard(ticket);
    },
  };
}
