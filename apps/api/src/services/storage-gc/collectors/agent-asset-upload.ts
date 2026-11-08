import {
  AGENT_ASSET_UPLOAD_TARGET,
  agentAssetUploadResourceSchema,
  type AgentAssetUploadResource,
  type StorageCollector,
} from "@doxahq/contracts/storage-gc";

import { agentAssetUploadPrefix } from "../../docs-branches/assets/agent-asset-upload-keys";
import type { VersionObjects } from "./docs-version-prefix";

/**
 * Deletes the ticket and the staged file of an MCP upload URL. The grace
 * period of the entry is longer than the URL lifetime, so the upload expired
 * before the runner claims it. A finished upload deleted its keys already,
 * and the collector finds nothing. An image that finished lives in its own
 * branch asset folder, never under this prefix.
 *
 * It leaves the member's open-upload ledger alone: changes to the ledger
 * need a compare-and-swap, and its entries expire on their own.
 */
export function createAgentAssetUploadCollector(input: {
  objects: VersionObjects;
}): StorageCollector<AgentAssetUploadResource> {
  return {
    target: AGENT_ASSET_UPLOAD_TARGET,
    parse: (resource) => agentAssetUploadResourceSchema.parse(resource),
    inspect: async () => ({ status: "collect" }),
    async collect(resource) {
      // The ticket and the file: two keys at most.
      const keys = await input.objects.listKeys(agentAssetUploadPrefix(resource.uploadId));
      if (keys.length > 0) await input.objects.removeMany(keys);
      return { deletedObjects: keys.length, status: "complete" };
    },
  };
}
