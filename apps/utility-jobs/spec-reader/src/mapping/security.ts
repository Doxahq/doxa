import {
  SPEC_READER_LIMITS,
  type SpecSecurity,
  type SpecSecurityScheme,
} from "@doxahq/contracts/spec-reader";
import {
  entriesOf,
  isSpecArray,
  isSpecObject,
  objectAt,
  stringAt,
  type SpecObject,
  type SpecValue,
} from "../document/tree";
import type { Located, ReferenceResolver } from "../references/resolver";
import { headerNameProblem } from "./operation-checks";
import { specName, specText } from "./text";

/**
 * The security schemes of `components.securitySchemes`: HTTP bearer and
 * basic, API keys in a header, query or cookie, OAuth 2 and OpenID
 * Connect. Mutual TLS and unknown types are left out. No URL in a scheme
 * is ever fetched.
 */
export function readSecuritySchemes(root: Located<SpecObject>, resolver: ReferenceResolver): SpecSecurityScheme[] {
  const components = objectAt(root.value, "components");
  const schemes = components ? objectAt(components, "securitySchemes") : undefined;
  if (!schemes) return [];

  return entriesOf(schemes).flatMap(([key, value]) => {
    const name = specName(key);
    const resolution = resolver.resolve({ value, file: root.file });
    if (!name || !resolution.ok || !isSpecObject(resolution.resolved.value)) return [];
    const scheme = readScheme(name, resolution.resolved.value);
    return scheme ? [scheme] : [];
  });
}

function readScheme(name: string, scheme: SpecObject): SpecSecurityScheme | undefined {
  const type = stringAt(scheme, "type")?.toLowerCase();
  const description = specText(stringAt(scheme, "description"), SPEC_READER_LIMITS.maxFieldDescriptionChars);
  const withDescription = (result: SpecSecurityScheme): SpecSecurityScheme =>
    description ? { ...result, description } : result;

  if (type === "http") {
    const httpScheme = stringAt(scheme, "scheme")?.toLowerCase();
    if (httpScheme === "bearer") return withDescription({ name, kind: "bearer" });
    if (httpScheme === "basic") return withDescription({ name, kind: "basic" });
    return undefined;
  }
  if (type === "apikey") {
    const location = stringAt(scheme, "in");
    const parameterName = specName(stringAt(scheme, "name"));
    if (location !== "header" && location !== "query" && location !== "cookie") return undefined;
    if (!parameterName || (location === "header" && headerNameProblem(parameterName))) return undefined;
    return withDescription({ name, kind: "apiKey", location, parameterName });
  }
  if (type === "oauth2") return withDescription({ name, kind: "oauth2" });
  if (type === "openidconnect") return withDescription({ name, kind: "openIdConnect" });
  return undefined;
}

/**
 * The security of an operation: its own `security`, else the root
 * `security`. An empty list, or a first requirement with no scheme, means
 * no auth. Otherwise the schemes of the first requirement that the spec
 * declares. Undefined when neither declares security.
 */
export function readSecurity(
  operationSecurity: SpecValue | undefined,
  rootSecurity: SpecValue | undefined,
  knownSchemes: ReadonlySet<string>,
): SpecSecurity | undefined {
  const security = operationSecurity ?? rootSecurity;
  if (!isSpecArray(security)) return undefined;
  const first = security[0];
  if (first === undefined || (isSpecObject(first) && Object.keys(first).length === 0)) {
    return { kind: "none" };
  }
  if (!isSpecObject(first)) return undefined;
  const schemeNames = Object.keys(first).filter((name) => knownSchemes.has(name));
  return schemeNames.length > 0 ? { kind: "schemes", schemeNames } : undefined;
}
