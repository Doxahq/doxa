/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * True only in the platform renderer build (`DOXA_RENDERER_BUILD=platform`).
   * That build reads every page through the dispatcher binding, so it leaves
   * the local content source out of the server bundle.
   */
  readonly DOXA_OMIT_LOCAL_CONTENT_SOURCE?: boolean;
}
