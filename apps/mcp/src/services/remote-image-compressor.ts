import type { AgentActionsRpc } from "@doxahq/api/services/agent-actions/rpc-contract";
import type {
  CompressedImage,
  ImageCompressor,
} from "@doxahq/api/services/site-assets/image-compression";

/** An upload waits this long at most. After that it stores the original. */
const COMPRESSION_TIMEOUT_MS = 8_000;

/** This Worker has no encoder: the Node origin compresses its uploads. */
export function createRemoteImageCompressor(
  actions: Pick<AgentActionsRpc, "compressImage">,
  timeoutMs = COMPRESSION_TIMEOUT_MS,
): ImageCompressor {
  return {
    async compress(input) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<CompressedImage | null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      try {
        return await Promise.race([actions.compressImage(input), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
