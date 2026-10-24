/**
 * File names that mark a spec, with no read of the file: `openapi.yaml`,
 * `swagger.json`, `openapi.v2.yml`, `orders.openapi.json`. Pure, so the
 * planner can use it in a Worker.
 */
const KNOWN_SPEC_NAME = /(?:^|\/)(?:(?:openapi|swagger)(?:[.-][\w-]+)?|[\w.-]+\.openapi)\.(?:json|ya?ml)$/i;

export function isKnownSpecFileName(path: string): boolean {
  return KNOWN_SPEC_NAME.test(path);
}
