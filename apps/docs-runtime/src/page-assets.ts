import {
  docsAssetArtifactPath,
  docsAssetNamesInSource,
} from "@doxahq/contracts/docs-assets";
import type { VersionTree, VersionTreeReader } from "@doxahq/docs-engine";

/**
 * The content hash of each asset that a page links to, by name, from the
 * version tree. The renderer turns `/assets/{name}` into the immutable URL
 * with it. Undefined when the page links to no asset of the version, so a
 * page without images keeps its exact former shape.
 */
export async function readPageAssetVersions(
  reader: Pick<VersionTreeReader, "readTree">,
  artifactPrefix: string,
  body: string,
): Promise<Record<string, string> | undefined> {
  const names = docsAssetNamesInSource(body);
  if (names.length === 0) return undefined;
  // A missing or unreadable tree only costs the long cache: the plain
  // `/assets/{name}` URL still loads the image.
  let tree: VersionTree | null;
  try {
    tree = await reader.readTree(artifactPrefix);
  } catch {
    return undefined;
  }
  if (!tree) return undefined;

  const versions: Record<string, string> = {};
  for (const name of names) {
    const entry = tree.files[docsAssetArtifactPath(name)];
    if (entry) versions[name] = entry.sha256;
  }
  return Object.keys(versions).length > 0 ? versions : undefined;
}
