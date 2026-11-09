import { DocsContentError } from "../docs-content/errors";

/** The isolated image worker gave no result, so the upload stored nothing. */
export function imageWorkerBusy(): DocsContentError {
  return new DocsContentError(
    "asset_upload_busy",
    "The server could not check this image right now. Try again.",
  );
}

/** Other uploads of the site held its lock for too long, so this one stored nothing. */
export function siteUploadsBusy(): DocsContentError {
  return new DocsContentError(
    "asset_upload_busy",
    "Other uploads of this site are running. Try again.",
  );
}
