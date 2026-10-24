import { branchPathSchema } from "@doxahq/contracts/docs-branches";
import { DOCS_CONTENT_MAX_PAGE_BYTES } from "@doxahq/contracts";
import { SITE_CONFIG_LIMITS } from "@doxahq/site-config";
import type {
  BranchChangeWrite,
  StoredBranchChange,
} from "../../repositories/docs-branches";
import { DocsContentError } from "../docs-content/errors";
import type { DocsContentStore } from "../docs-content/store";
import { mapWithConcurrency } from "../../utils/concurrency";
import { isAssetPath } from "./assets/branch-assets";

const STRUCTURE_MAX_BYTES = 256 * 1024;
const ASSET_POINTER_MAX_BYTES = 4 * 1024;
const READ_CONCURRENCY = 16;

export type DesiredChange = string | null | undefined;

export async function prepareWorkingChanges(input: {
  store: Pick<DocsContentStore, "read">;
  basePrefix: string;
  existing: readonly StoredBranchChange[];
  desired: ReadonlyMap<string, DesiredChange>;
}): Promise<BranchChangeWrite[]> {
  const existing = new Map(
    input.existing.map((change) => [change.path, change]),
  );
  const entries = [...input.desired].map(([path, desired]) => {
    branchPathSchema.parse(path);

    const bytes =
      typeof desired === "string" ? new TextEncoder().encode(desired) : null;

    if (bytes && bytes.byteLength > limitForPath(path)) {
      throw new DocsContentError(
        "invalid",
        `The content at ${path} is too large to save.`,
      );
    }

    return { path, desired, bytes };
  });
  // An image change is a pointer, never the bytes of the base file, so it
  // never equals the base.
  const bases = await mapWithConcurrency(
    entries,
    READ_CONCURRENCY,
    ({ path }) =>
      isAssetPath(path)
        ? Promise.resolve(null)
        : input.store.read(`${input.basePrefix}/${path}`),
  );
  const writes: BranchChangeWrite[] = [];

  for (const [index, { path, desired, bytes }] of entries.entries()) {
    const base = bases[index];
    const next = desired === undefined ? base : desired;
    const current = existing.get(path);
    const currentContent = current
      ? current.kind === "upsert"
        ? current.content
        : null
      : base;

    if (next === currentContent) {
      continue;
    }

    if (next === base) {
      writes.push({ path, kind: "reset" });
      continue;
    }

    if (next === null) {
      writes.push({ path, kind: "delete" });
      continue;
    }

    const nextBytes = bytes ?? new TextEncoder().encode(next);
    const digest = await crypto.subtle.digest("SHA-256", nextBytes);
    const contentSha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    writes.push({
      path,
      kind: "upsert",
      content: next,
      contentSha256,
      byteSize: nextBytes.byteLength,
    });
  }

  return writes;
}

function limitForPath(path: string): number {
  if (isAssetPath(path)) {
    return ASSET_POINTER_MAX_BYTES;
  }

  if (path.startsWith("source/")) {
    return DOCS_CONTENT_MAX_PAGE_BYTES;
  }

  if (path === "settings/site.json") {
    return SITE_CONFIG_LIMITS.configBytes;
  }

  return STRUCTURE_MAX_BYTES;
}
