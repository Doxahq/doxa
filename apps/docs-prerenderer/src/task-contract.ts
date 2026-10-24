import {
  prerenderTaskPayloadSchema,
  type PrerenderTaskPayload,
} from "@doxahq/contracts/docs-prerender-tasks";
import {
  prerenderIdentitySchema,
  type PrerenderIdentity,
} from "@doxahq/contracts/docs-prerender";

export { prerenderTaskPayloadSchema, type PrerenderTaskPayload };

export function validateTaskForRelease(
  input: unknown,
  rendererReleaseId: string,
): PrerenderTaskPayload {
  const task = prerenderTaskPayloadSchema.parse(input);
  if (!/^[a-f0-9]{64}$/.test(rendererReleaseId)) {
    throw new Error("The server renderer release is not configured.");
  }
  if (task.identity.rendererReleaseId !== rendererReleaseId) {
    throw new Error(
      "The task renderer release does not match this deployment.",
    );
  }
  return task;
}

export function validateIdentityForRelease(
  input: unknown,
  rendererReleaseId: string,
): PrerenderIdentity {
  const identity = prerenderIdentitySchema.parse(input);
  if (!/^[a-f0-9]{64}$/.test(rendererReleaseId)) {
    throw new Error("The server renderer release is not configured.");
  }
  if (identity.rendererReleaseId !== rendererReleaseId) {
    throw new Error(
      "The render identity does not match this deployment.",
    );
  }
  return identity;
}
