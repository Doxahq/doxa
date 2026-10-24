import type {
  DocPage,
  DocSection,
  DocumentationStructure,
  ProjectAnalysis,
  ProjectReferenceSurfaces,
  RestApiReferenceGroup,
  RestApiReferenceEndpoint,
  SdkApiReferenceModule,
  SectionConfig,
  RestApiReferenceSurface,
} from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";
import { hashObject } from "../utils/hash";
import { sanitizeDisplayText } from "../utils/frontmatter";
import { hasUnbalancedPunctuation } from "../utils/title-validation";
import { StructurePipelineDefectError } from "./structure-review-errors";
import { slugify } from "./structure-utils";
import {
  DEFAULT_REST_API_DOCS_POLICY,
  resolveRestApiDocsPolicy,
  type RestApiDocsPolicy,
} from "./rest-api-policy";

export interface ReferenceSectionDefaults {
  restApi: {
    label: string;
    slug: string;
  };
  sdkApi: {
    label: string;
    slug: string;
  };
  restApiPolicy: RestApiDocsPolicy;
}

export const DEFAULT_REFERENCE_SECTION_DEFAULTS: ReferenceSectionDefaults = {
  restApi: { label: "REST API", slug: "rest-api" },
  sdkApi: { label: "API Reference", slug: "api-reference" },
  restApiPolicy: DEFAULT_REST_API_DOCS_POLICY,
};

const MIN_REFERENCE_DESCRIPTION_LENGTH = 40;

export function referenceSectionDefaultsFromAnswers(
  answers: Record<string, unknown>,
): ReferenceSectionDefaults {
  const record = asRecord(answers.referenceSections);
  return {
    restApi: readSectionDefault(record?.restApi, DEFAULT_REFERENCE_SECTION_DEFAULTS.restApi),
    sdkApi: readSectionDefault(record?.sdkApi, DEFAULT_REFERENCE_SECTION_DEFAULTS.sdkApi),
    restApiPolicy: resolveRestApiDocsPolicy(answers),
  };
}

interface ReferenceSectionSpec {
  surface: "rest" | "sdk";
  id: string;
  title: string;
  description: string;
  pages: DocPage[];
  restGroupTitles?: ReadonlyMap<string, string>;
}

interface ReferencePageIdentityRegistry {
  stablePageIds: Set<string>;
  normalizedTitlesByScope: Map<string, Set<string>>;
}

/** The id and title that a reference page had in an earlier version. */
interface PreviousReferenceIdentity {
  id: string;
  title: string;
}

type PageIdentityKey = (candidateId: string) => string;

/**
 * Puts the REST and SDK reference sections, built from analysis, into a
 * structure. The result is the same however often it runs:
 *
 * - A reference page avoids only the ids and titles of editorial pages. The
 *   reference pages already in the structure, such as the previous version
 *   that the planner echoed, are replaced and reserve nothing.
 * - With `previous`, a reference page keeps the id and title that it had
 *   there, matched by what it documents (the endpoint method and path, the
 *   group, or the module), so its route and name do not change between runs.
 */
export interface ReferenceSectionOptions {
  /**
   * Gives a published id that is only an old collision mark its plain id
   * again. A new plan may do it; a patch keeps every published route.
   */
  dropCollisionMarks?: boolean;
}

export function ensureReferenceSections(
  structure: DocumentationStructure,
  analysis: ProjectAnalysis,
  defaults: ReferenceSectionDefaults = DEFAULT_REFERENCE_SECTION_DEFAULTS,
  previous?: DocumentationStructure,
  options: ReferenceSectionOptions = {},
): DocumentationStructure {
  const normalized = normalizeProjectAnalysis(analysis);
  const builtSpecs = buildReferenceSectionSpecs(normalized.referenceSurfaces, defaults);
  if (builtSpecs.length === 0) return structure;

  const existingIdentities = collectEditorialIdentities(structure, builtSpecs);
  const previousIdentities = collectReferenceIdentities(previous);
  const specs = builtSpecs.map((spec) => ({
    ...spec,
    pages: spec.pages.map((page) => reserveReferencePageIdentity(
      page,
      spec,
      existingIdentities,
      previousIdentities.get(referenceIdentityKey(page) ?? ""),
      options.dropCollisionMarks === true,
    )),
  }));

  const sections = structure.sections.map((section) => ({
    ...section,
    pages: [...section.pages],
  }));

  for (const spec of specs) {
    upsertReferenceSection(sections, spec);
  }

  return { sections: orderReferenceSections(sections, specs) };
}

/**
 * The ids and titles of the editorial pages, which reference pages must not
 * take. A section that the injection replaces, and a page that is itself a
 * reference page, are left out: they do not survive the injection.
 */
function collectEditorialIdentities(
  structure: DocumentationStructure,
  specs: readonly ReferenceSectionSpec[],
): ReferencePageIdentityRegistry {
  const stablePageIds = new Set<string>();
  const normalizedTitlesByScope = new Map<string, Set<string>>();
  const replaced = replacedSectionIndexes(structure.sections, specs);

  structure.sections.forEach((section, index) => {
    if (replaced.has(index)) return;
    for (const page of section.pages) {
      if (page.reference) continue;
      stablePageIds.add(topLevelPageIdentity(section.id, page.id));
      reserveTitleInScope(normalizedTitlesByScope, titleScope(section.id, page), page.title);
    }
  });

  return { stablePageIds, normalizedTitlesByScope };
}

/** The sections that `upsertReferenceSection` replaces, one for each spec. */
function replacedSectionIndexes(
  sections: readonly DocSection[],
  specs: readonly ReferenceSectionSpec[],
): Set<number> {
  const indexes = new Set<number>();
  for (const spec of specs) {
    const index = sections.findIndex((section) => sectionMatchesSpec(section, spec));
    if (index >= 0) indexes.add(index);
  }
  return indexes;
}

/** The id and title of each reference page of a structure, by what it documents. */
function collectReferenceIdentities(
  structure: DocumentationStructure | undefined,
): Map<string, PreviousReferenceIdentity> {
  const identities = new Map<string, PreviousReferenceIdentity>();
  for (const section of structure?.sections ?? []) {
    for (const page of section.pages) {
      const key = referenceIdentityKey(page);
      if (key && !identities.has(key)) identities.set(key, { id: page.id, title: page.title });
    }
  }
  return identities;
}

/**
 * What a reference page documents, independent of its id and title: the
 * endpoint method and path, the resource group, the overview or the
 * authentication page, or the SDK module. Null for an editorial page.
 */
export function referenceIdentityKey(page: Pick<DocPage, "reference">): string | null {
  const reference = page.reference;
  if (!reference) return null;
  if (reference.kind === "sdk") return reference.moduleId ? `sdk:module:${reference.moduleId}` : null;

  switch (reference.pageKind) {
    case "overview":
    case "auth":
      return `rest:${reference.pageKind}`;
    case "group":
      return reference.groupId ? `rest:group:${slugify(reference.groupId)}` : null;
    case "endpoint":
      return reference.method && reference.path
        ? `rest:endpoint:${endpointRouteId(reference.method, reference.path)}`
        : null;
    default:
      return null;
  }
}

function reserveReferencePageIdentity(
  page: DocPage,
  spec: ReferenceSectionSpec,
  identities: ReferencePageIdentityRegistry,
  previous: PreviousReferenceIdentity | undefined,
  dropCollisionMarks: boolean,
): DocPage {
  const qualifier = referenceTitleQualifier(page, spec);
  const preserveTitle = shouldPreserveReferenceTitle(page);
  const pageId = uniqueReferencePageId(
    dropCollisionMarks ? preferredReferencePageId(page.id, spec.id, previous) : previous?.id ?? page.id,
    spec.id,
    identities.stablePageIds,
    (candidateId) => topLevelPageIdentity(spec.id, candidateId),
  );
  return {
    ...page,
    id: pageId,
    title: uniqueReferencePageTitle(
      previous ? withoutReferenceQualifier(previous.title, qualifier, preserveTitle) : page.title,
      titleScope(spec.id, page),
      qualifier,
      identities.normalizedTitlesByScope,
      preserveTitle,
    ),
  };
}

/**
 * The id that a reference page asks for: its published id, so its route
 * stays the same across runs. A published id that is only the collision
 * mark of `uniqueReferencePageId` (`<section>-<id>` or `<section>-<id>-2`)
 * asks for the plain id again; the mark comes back only if it still
 * collides, so an old collision does not stay in the route forever.
 */
function preferredReferencePageId(
  plainId: string,
  sectionId: string,
  previous: PreviousReferenceIdentity | undefined,
): string {
  if (!previous) return plainId;
  const marked = `${slugify(sectionId)}-${plainId}`;
  const isCollisionMark = previous.id === marked ||
    (previous.id.startsWith(`${marked}-`) && /^\d+$/.test(previous.id.slice(marked.length + 1)));
  return isCollisionMark ? plainId : previous.id;
}

/**
 * A previous title without the qualifier that the uniqueness step added to
 * it, such as "Create webhook (Webhooks)" or "API Reference: Core 2". The
 * qualifier comes back only if the plain title collides again.
 */
function withoutReferenceQualifier(title: string, qualifier: string, preserveTitle: boolean): string {
  const escaped = qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plain = preserveTitle
    ? title.replace(new RegExp(`\\s\\(${escaped}(?:\\s\\d+)?\\)$`), "")
    : title.replace(new RegExp(`^${escaped}:\\s(.+?)(?:\\s\\d+)?$`), "$1");
  return plain.trim() || title;
}

function uniqueReferencePageId(
  id: string,
  sectionSlug: string,
  stablePageIds: Set<string>,
  identityKey: PageIdentityKey,
): string {
  const initialIdentity = identityKey(id);
  if (!stablePageIds.has(initialIdentity)) {
    stablePageIds.add(initialIdentity);
    return id;
  }

  const prefixedId = `${slugify(sectionSlug)}-${id}`;
  let candidate = prefixedId;
  let suffix = 2;
  while (stablePageIds.has(identityKey(candidate))) {
    candidate = `${prefixedId}-${suffix}`;
    suffix += 1;
  }
  stablePageIds.add(identityKey(candidate));
  return candidate;
}

function topLevelPageIdentity(sectionId: string, pageId: string): string {
  return `${sectionId}/${pageId}`;
}

function uniqueReferencePageTitle(
  title: string,
  scope: string,
  qualifier: string,
  normalizedTitlesByScope: Map<string, Set<string>>,
  preserveTitle: boolean,
): string {
  const normalizedTitles = normalizedTitlesByScope.get(scope) ?? new Set<string>();
  normalizedTitlesByScope.set(scope, normalizedTitles);
  let candidate = title;
  if (normalizedTitles.has(normalizePageTitle(candidate))) {
    const labelledTitle = preserveTitle
      ? `${title} (${qualifier})`
      : `${qualifier}: ${title}`;
    candidate = labelledTitle;
    let suffix = 2;
    while (normalizedTitles.has(normalizePageTitle(candidate))) {
      candidate = preserveTitle
        ? `${title} (${qualifier} ${suffix})`
        : `${labelledTitle} ${suffix}`;
      suffix += 1;
    }
  }

  assertGeneratedReferenceTitle(candidate, preserveTitle);
  normalizedTitles.add(normalizePageTitle(candidate));
  return candidate;
}

function reserveTitleInScope(
  titlesByScope: Map<string, Set<string>>,
  scope: string,
  title: string,
): void {
  const titles = titlesByScope.get(scope) ?? new Set<string>();
  titles.add(normalizePageTitle(title));
  titlesByScope.set(scope, titles);
}

function titleScope(
  sectionId: string,
  page: Pick<DocPage, "reference">,
): string {
  if (page.reference?.kind === "rest") {
    return `rest:${sectionId}:${page.reference.groupId ?? "ungrouped"}`;
  }
  return "editorial";
}

function referenceTitleQualifier(
  page: Pick<DocPage, "reference">,
  spec: ReferenceSectionSpec,
): string {
  if (page.reference?.kind === "rest" && page.reference.groupId) {
    return spec.restGroupTitles?.get(page.reference.groupId) ??
      page.reference.groupId.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return spec.title;
}

function shouldPreserveReferenceTitle(
  page: Pick<DocPage, "reference">,
): boolean {
  return page.reference?.kind === "rest" && Boolean(page.reference.endpointId);
}

function assertGeneratedReferenceTitle(
  candidate: string,
  preserveTitle: boolean,
): void {
  const rendered = preserveTitle ? candidate.trim() : sanitizeDisplayText(candidate);
  if (
    rendered !== candidate ||
    hasUnbalancedPunctuation(rendered)
  ) {
    throw new StructurePipelineDefectError(
      `Generated reference page title "${candidate}" does not survive frontmatter ` +
        `sanitization (became "${rendered}"). This is a defect in reference page ` +
        "generation, not in the model output.",
    );
  }
}

function normalizePageTitle(title: string): string {
  return title.trim().replace(/^`|`$/g, "").toLowerCase();
}

export function sectionConfigForStructure(
  structure: DocumentationStructure,
): SectionConfig[] {
  return structure.sections.map((section) => {
    const slug = section.default ? "default" : slugify(section.id || section.title);
    const isReference = isReferenceSection(section);
    const isDevelopment = /development|contributing/i.test(section.title);
    return {
      slug,
      label: section.title,
      ...(section.default ? { default: true as const } : {}),
      ...(isReference ? { kind: "reference" as const, layout: "reference" as const } : {}),
      ...(!isReference && isDevelopment ? { kind: "development" as const } : {}),
      ...(!isReference && !isDevelopment ? { kind: "documentation" as const } : {}),
    };
  });
}

function buildReferenceSectionSpecs(
  surfaces: ProjectReferenceSurfaces | undefined,
  defaults: ReferenceSectionDefaults,
): ReferenceSectionSpec[] {
  const specs: ReferenceSectionSpec[] = [];

  if (surfaces?.rest?.groups.length) {
    const title = defaults.restApi.label;
    const id = defaults.restApi.slug;
    specs.push({
      surface: "rest",
      id,
      title,
      description: surfaces.rest.description ||
        "Reference documentation for public REST API endpoints served by this project.",
      pages: createRestEndpointPages(id, surfaces.rest, defaults.restApiPolicy),
      restGroupTitles: new Map(
        surfaces.rest.groups.map((group) => [group.id, group.title]),
      ),
    });
  }

  if (surfaces?.sdk?.modules.length) {
    const title = defaults.sdkApi.label;
    const id = defaults.sdkApi.slug;
    specs.push({
      surface: "sdk",
      id,
      title,
      description: surfaces.sdk.description ||
        "Reference documentation for public SDK and library APIs exported by this project.",
      pages: surfaces.sdk.modules.map(createSdkModulePage),
    });
  }

  return specs;
}

function createRestEndpointPages(
  sectionId: string,
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
): DocPage[] {
  const pageGroups = surface.groups.map((group) => ({
    group,
    endpointPages: group.endpoints.map((endpoint) =>
      createRestEndpointPage(surface, group, endpoint)
    ),
  }));
  const endpointPages = pageGroups.flatMap(({ endpointPages: pages }) => pages);
  assertUniqueEndpointPageIds(sectionId, surface.groups, endpointPages);

  const pages: DocPage[] = [];
  if (policy.overviewPage.enabled) {
    pages.push(createRestOverviewPage(surface, policy));
  }
  const authPage = createRestAuthPage(surface, policy);
  if (authPage) pages.push(authPage);

  for (const { group, endpointPages: groupEndpointPages } of pageGroups) {
    if (policy.groupPages.enabled) {
      pages.push(createRestGroupPage(group));
    }
    pages.push(...groupEndpointPages);
  }
  return pages;
}

function createRestOverviewPage(
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
): DocPage {
  return {
    id: policy.overviewPage.id,
    title: policy.overviewPage.title,
    description: descriptionOrFallback(
      surface.description,
      "Explore the public REST API base URL, authentication, resources, and endpoint inventory.",
    ),
    sourceEvidence: surface.sourceEvidence,
    audience: "reference",
    reference: {
      kind: "rest",
      pageKind: "overview",
    },
  };
}

function createRestAuthPage(
  surface: RestApiReferenceSurface,
  policy: RestApiDocsPolicy,
): DocPage | undefined {
  if (!policy.authPage.enabled || !surface.authSchemes?.length) {
    return undefined;
  }

  return {
    id: policy.authPage.id,
    title: policy.authPage.title,
    description: "Authenticate requests to the public REST API with the supported credential schemes.",
    sourceEvidence: surface.sourceEvidence,
    audience: "reference",
    reference: {
      kind: "rest",
      pageKind: "auth",
    },
  };
}

function createRestGroupPage(group: RestApiReferenceGroup): DocPage {
  return {
    id: slugify(group.id),
    title: group.title,
    description: descriptionOrFallback(
      group.description,
      `Explore the ${group.title} resource schema and its public REST API endpoints.`,
    ),
    sourceEvidence: group.sourceEvidence,
    audience: "reference",
    reference: {
      kind: "rest",
      pageKind: "group",
      groupId: group.id,
    },
  };
}

function createRestEndpointPage(
  surface: RestApiReferenceSurface,
  group: RestApiReferenceGroup,
  endpoint: RestApiReferenceEndpoint,
): DocPage {
  const title = endpointPageTitle(endpoint, surface.source?.kind === "openapi");
  return {
    id: endpointPageId(endpoint),
    title,
    description: descriptionOrFallback(endpoint.description, endpointDescriptionFallback(endpoint, title)),
    sourceEvidence: endpoint.sourceEvidence,
    audience: "reference" as const,
    reference: {
      kind: "rest" as const,
      pageKind: "endpoint" as const,
      groupId: group.id,
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      factsHash: restEndpointFactsHash(surface, endpoint),
    },
  };
}

/**
 * The hash of what the endpoint template renders from the analysis: the
 * endpoint facts and the surface settings that every endpoint page shows.
 * Source evidence is left out; the page input hash covers its paths.
 */
export function restEndpointFactsHash(
  surface: Pick<RestApiReferenceSurface, "baseUrl" | "servers" | "authSchemes">,
  endpoint: RestApiReferenceEndpoint,
): string {
  const { sourceEvidence, ...facts } = endpoint;
  return hashObject({
    endpoint: facts,
    baseUrl: surface.baseUrl,
    servers: surface.servers,
    authSchemes: surface.authSchemes,
  });
}

export function endpointPageId(endpoint: RestApiReferenceEndpoint): string {
  return endpointRouteId(endpoint.method, endpoint.path);
}

/** The longest endpoint ID. A longer slug keeps its start and ends with a hash of the whole. */
const MAX_ENDPOINT_ID_LENGTH = 120;

/**
 * The slug of an endpoint method and path, the same for colon and OpenAPI
 * parameters. It matches `^[a-z0-9-]{1,120}$`, so it is safe in a file path.
 */
export function endpointRouteId(method: string, path: string): string {
  const normalizedPath = path
    .replace(/\/:([A-Za-z_]\w*)/g, "/{$1}")
    .replace(/\/([^/]+)\/\{([^/}]+)\}(?=\/(?!\{)[^/]+)/g, (segment, resource: string, parameter: string) => {
      const expectedParameter = `${resource.replace(/s$/i, "")}Id`;
      return parameter.toLowerCase() === expectedParameter.toLowerCase()
        ? `/${resource}`
        : segment;
    })
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[:{}]/g, "");
  const slug = slugify(`${method}-${normalizedPath}`);
  if (slug.length <= MAX_ENDPOINT_ID_LENGTH) return slug;
  return `${slug.slice(0, MAX_ENDPOINT_ID_LENGTH - 9).replace(/-+$/, "")}-${hashObject(slug).slice(0, 8)}`;
}

/**
 * The title of an endpoint page. A model title must be a short plain phrase;
 * a spec summary may be longer, up to 80 characters. Otherwise the title
 * comes from the method and path.
 */
export function endpointPageTitle(endpoint: RestApiReferenceEndpoint, fromSpec = false): string {
  const provided = endpoint.title?.trim();
  if (provided && (fromSpec ? isSpecEndpointTitle(provided) : isPlainEndpointTitle(provided))) {
    return provided;
  }
  return deriveEndpointTitle(endpoint);
}

/** The longest spec summary that becomes an endpoint title. */
export const MAX_SPEC_ENDPOINT_TITLE_LENGTH = 80;

/**
 * A spec summary that can be an endpoint title as it is: trimmed, at most
 * 80 characters, with balanced brackets and quotes, no path or braces, and
 * no HTTP method at the start. The method and path show on the page anyway.
 */
export function isSpecEndpointTitle(title: string): boolean {
  return title.length > 0 &&
    title.length <= MAX_SPEC_ENDPOINT_TITLE_LENGTH &&
    title === title.trim() &&
    !/[\/{}\n]/.test(title) &&
    !hasUnbalancedPunctuation(title) &&
    !HTTP_METHOD_PREFIX.test(title);
}

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "QUERY",
] as const;

/** An upper-case method at the start, as in `GET /users`. "Get users" is a fine title. */
const HTTP_METHOD_PREFIX = new RegExp(`^(?:${HTTP_METHODS.join("|")})\\b`);

const METHOD_VERBS: Record<(typeof HTTP_METHODS)[number], string> = {
  GET: "Get",
  POST: "Create",
  PUT: "Update",
  PATCH: "Update",
  DELETE: "Delete",
  HEAD: "Check",
  OPTIONS: "Inspect",
  QUERY: "Search",
};

function isPlainEndpointTitle(title: string): boolean {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (/[\/{},:;?]/.test(title) || /[.!]$/.test(title)) return false;
  return !HTTP_METHOD_PREFIX.test(title);
}

function deriveEndpointTitle(endpoint: RestApiReferenceEndpoint): string {
  const method = endpoint.method.toUpperCase();
  const verb = isHttpMethod(method) ? METHOD_VERBS[method] : "Use";
  const segments = endpoint.path.split("/").filter(Boolean);
  const endsInParameter = /^\{[^}]+\}$/.test(segments.at(-1) ?? "");
  const resourceSegment = [...segments]
    .reverse()
    .find((segment) => !/^\{[^}]+\}$/.test(segment) && !/^v\d+$/i.test(segment)) ??
    "endpoint";
  const resource = humanizeResource(resourceSegment);

  if (method === "GET" && !endsInParameter) {
    const singular = singularizeResource(resource);
    return singular !== resource ? `List ${resource}` : `Get ${resource}`;
  }
  const singular = singularizeResource(resource);
  return `${verb} ${indefiniteArticle(singular)} ${singular}`;
}

function isHttpMethod(value: string): value is (typeof HTTP_METHODS)[number] {
  return HTTP_METHODS.some((method) => method === value);
}

function humanizeResource(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase() || "endpoint";
}

function singularizeResource(value: string): string {
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/(status|news)$/i.test(value)) return value;
  if (/sses$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value) && !/ss$/i.test(value)) return value.slice(0, -1);
  return value;
}

function indefiniteArticle(value: string): "a" | "an" {
  return /^[aeio]/i.test(value) ? "an" : "a";
}

/**
 * Fails when one method and path appears twice: the analysis or the spec
 * listed one endpoint two times. Two different paths may share a page ID
 * (`/users/{userId}/posts` and `/users/posts`); the identity step then
 * gives the second page its own ID.
 */
function assertUniqueEndpointPageIds(
  sectionId: string,
  groups: RestApiReferenceGroup[],
  pages: DocPage[],
): void {
  const endpoints = groups.flatMap((group) =>
    group.endpoints.map((endpoint) => ({ endpoint, groupId: group.id }))
  );
  const endpointByRoute = new Map<
    string,
    { endpoint: RestApiReferenceEndpoint; groupId: string }
  >();
  for (const [index, page] of pages.entries()) {
    const candidate = endpoints[index];
    if (!candidate) continue;
    const route = `${candidate.endpoint.method.toUpperCase()} ${normalizedEndpointPath(candidate.endpoint.path)}`;
    const existing = endpointByRoute.get(route);
    if (existing) {
      throw new StructurePipelineDefectError(
        `REST endpoint listed twice in section "${sectionId}": ` +
          `${existing.endpoint.method} ${existing.endpoint.path} (group "${existing.groupId}") and ` +
          `${candidate.endpoint.method} ${candidate.endpoint.path} (group "${candidate.groupId}") ` +
          `are one endpoint with page ID "${page.id}". ` +
          "This is a defect in reference page generation, not in the model output.",
      );
    }
    endpointByRoute.set(route, candidate);
  }
}

/** A path with colon parameters written as OpenAPI parameters, and no trailing slash. */
function normalizedEndpointPath(path: string): string {
  return path.replace(/\/:([A-Za-z_]\w*)/g, "/{$1}").replace(/\/+$/, "") || "/";
}

function createSdkModulePage(module: SdkApiReferenceModule): DocPage {
  const descriptionFallback =
    `API reference for all ${module.exports.length} public exports from ` +
    `${module.title}, including imports, signatures, parameters, and examples.`;

  return {
    id: module.id,
    title: module.title,
    description: descriptionOrFallback(module.description, descriptionFallback),
    sourceEvidence: uniqueEvidence([
      ...module.sourceEvidence,
      ...module.exports.flatMap((entry) => entry.sourceEvidence),
    ]),
    audience: "reference",
    reference: {
      kind: "sdk",
      moduleId: module.id,
    },
  };
}

function uniqueEvidence(
  evidence: NonNullable<DocPage["sourceEvidence"]>,
): NonNullable<DocPage["sourceEvidence"]> {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (!item.path || seen.has(item.path)) {
      return false;
    }
    seen.add(item.path);
    return true;
  });
}

/**
 * The page description of an endpoint whose own description is missing or
 * short. It names no path: the description cleanup removes slashes and
 * braces, which would leave a broken path in the prose.
 */
function endpointDescriptionFallback(endpoint: RestApiReferenceEndpoint, title: string): string {
  const description = endpoint.description.trim();
  if (!description) return `${title}: the parameters, responses and errors of this endpoint.`;
  return `${/[.!?]$/.test(description) ? description : `${description}.`} This page lists its parameters, responses and errors.`;
}

function descriptionOrFallback(description: string | undefined, fallback: string): string {
  const trimmed = description?.trim();
  return trimmed && trimmed.length >= MIN_REFERENCE_DESCRIPTION_LENGTH
    ? trimmed
    : fallback;
}

function upsertReferenceSection(
  sections: DocSection[],
  spec: ReferenceSectionSpec,
): void {
  const existingIndex = sections.findIndex((section) => sectionMatchesSpec(section, spec));
  const referenceSection: DocSection = {
    id: spec.id,
    title: spec.title,
    pages: spec.pages,
  };

  if (existingIndex >= 0) {
    sections[existingIndex] = {
      ...sections[existingIndex],
      id: spec.id,
      title: spec.title,
      pages: spec.pages,
      default: undefined,
    };
    return;
  }

  sections.push(referenceSection);
}

function sectionMatchesSpec(section: DocSection, spec: ReferenceSectionSpec): boolean {
  const key = slugify(`${section.id} ${section.title}`);
  const specKey = slugify(`${spec.id} ${spec.title}`);
  if (key.includes(spec.id) || specKey.includes(slugify(section.id))) return true;
  if (spec.surface === "rest") return /\b(rest|http|endpoint)s?\b/.test(key);
  return /\b(api|sdk|reference|exports?)\b/.test(key) && !/\b(rest|http|endpoint)s?\b/.test(key);
}

function orderReferenceSections(
  sections: DocSection[],
  specs: ReferenceSectionSpec[],
): DocSection[] {
  const specIds = new Set(specs.map((spec) => spec.id));
  const defaultSections = sections.filter((section) => section.default);
  const referenceSections = specs
    .map((spec) => sections.find((section) => section.id === spec.id))
    .filter((section): section is DocSection => Boolean(section));
  const otherSections = sections.filter((section) =>
    !section.default && !specIds.has(section.id)
  );
  return [...defaultSections, ...referenceSections, ...otherSections];
}

function isReferenceSection(section: DocSection): boolean {
  return section.pages.some((page) =>
    page.reference?.kind === "rest" ||
    page.reference?.kind === "sdk"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readSectionDefault(
  value: unknown,
  fallback: ReferenceSectionDefaults["restApi"],
): ReferenceSectionDefaults["restApi"] {
  const record = asRecord(value);
  const label = typeof record?.label === "string" && record.label.trim()
    ? record.label.trim()
    : fallback.label;
  const slug = typeof record?.slug === "string" && record.slug.trim()
    ? slugify(record.slug)
    : fallback.slug;
  return { label, slug };
}
