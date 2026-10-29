export class RuntimeSourceError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "RuntimeSourceError";
  }
}

/**
 * The content runtime's code for a hostname or project without published
 * docs. The runtime answers it as a 404.
 */
const NO_PUBLISHED_DOCS_CODE = "project_not_found";

/** True when the content runtime has no published docs for the request. */
export function isNoPublishedDocsError(error: unknown): boolean {
  return (
    error instanceof RuntimeSourceError && error.code === NO_PUBLISHED_DOCS_CODE
  );
}

/**
 * The code of a renderer call that reached the isolate without the request
 * scope in its entrypoint props. In the shared `build` isolate (M46) this
 * must fail closed: the isolate has no site of its own to fall back to.
 */
export const RENDERER_PROPS_MISSING_CODE = "renderer_props_missing";

/** The header that carries the code on the renderer's 5xx response. */
export const RENDERER_ERROR_HEADER = "x-doxa-renderer-error";

export class RendererPropsMissingError extends Error {
  readonly code = RENDERER_PROPS_MISSING_CODE;

  constructor() {
    // RPC passes only the message to the dispatcher, so it carries the code.
    super(
      `[${RENDERER_PROPS_MISSING_CODE}] The renderer call has no request scope in its entrypoint props.`
    );
    this.name = "RendererPropsMissingError";
  }
}
