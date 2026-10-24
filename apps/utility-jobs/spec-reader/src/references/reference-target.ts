import { parseJsonPointer } from "./json-pointer";
import { isSpecFilePath, resolveRelativeSpecPath } from "./spec-paths";

export interface ReferenceTarget {
  file: string;
  pointer: string[];
  /** `file#pointer`, the identity of the target. */
  key: string;
}

export type ReferenceTargetResult =
  | { ok: true; target: ReferenceTarget }
  | { ok: false; message: string };

/** `http:`, `https:`, `file:`, `data:` and any other scheme. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Where a `$ref` points. Only a JSON pointer in the same file or in another
 * spec file of the checkout is followed. A URL, a protocol-relative or
 * absolute path, a path that leaves the checkout and an anchor name are
 * refused: Doxa never reads a reference over the network or outside the
 * repository, whatever `$self` or `$id` say.
 */
export function referenceTarget(reference: string, fromFile: string): ReferenceTargetResult {
  if (URL_SCHEME.test(reference) || reference.startsWith("//")) {
    return { ok: false, message: "A reference to a URL is never followed." };
  }

  const hashIndex = reference.indexOf("#");
  const filePart = hashIndex < 0 ? reference : reference.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? "" : reference.slice(hashIndex + 1);

  const file = filePart === "" ? fromFile : resolveRelativeSpecPath(fromFile, filePart);
  if (file === undefined) {
    return { ok: false, message: "A reference must stay inside the repository." };
  }
  if (!isSpecFilePath(file)) {
    return { ok: false, message: "A reference must point to a .json, .yaml or .yml file." };
  }

  let decodedFragment: string;
  try {
    decodedFragment = decodeURIComponent(fragment);
  } catch {
    return { ok: false, message: "A reference has bad percent-encoding." };
  }
  const pointer = parseJsonPointer(decodedFragment);
  if (pointer === undefined) {
    return { ok: false, message: "A reference must use a JSON pointer, not an anchor name." };
  }
  return { ok: true, target: { file, pointer, key: `${file}#${decodedFragment}` } };
}
