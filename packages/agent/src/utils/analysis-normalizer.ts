import type {
  DocumentationCollection,
  DocumentationCollectionItem,
  ProjectAnalysis,
  ProjectReferenceSurfaces,
  ReferenceSourceReport,
  RestApiReferenceEndpoint,
  RestApiReferenceExtraction,
  RestApiReferenceAuth,
  RestApiReferenceField,
  RestApiReferenceGroup,
  RestApiReferenceParameter,
  RestApiReferenceResponse,
  RestApiReferenceSource,
  RestApiReferenceSurface,
  SdkApiReferenceExport,
  SdkApiReferenceModule,
  SdkReferenceExportKind,
  SourceEvidence,
} from "../types";
import { referenceSourceReportSchema } from "@doxahq/contracts";

type ProjectCategory = ProjectAnalysis["projectCategory"];
type ProjectProfile = NonNullable<ProjectAnalysis["projectProfile"]>;
type CliCommand = ProjectAnalysis["cliCommands"][number];
type ApiEndpoint = ProjectAnalysis["apiEndpoints"][number];
type ConfigFile = ProjectAnalysis["configFiles"][number];
type PackageInfo = ProjectAnalysis["packages"][number];
type DocumentationIntent = NonNullable<ProjectAnalysis["documentationIntent"]>;
type CanonicalWorkflow = DocumentationIntent["canonicalWorkflows"][number];
type ReferenceSurfaces = NonNullable<ProjectAnalysis["referenceSurfaces"]>;
type PublicEditorialBrief = NonNullable<ProjectAnalysis["publicEditorialBrief"]>;

interface ReferenceCollectionCandidate {
  referenceKind: "REST API" | "SDK API";
  unit: "groups" | "modules";
  id: string;
  title: string;
  sourcePaths: string[];
}

interface ReferenceCollectionOverlap {
  referenceKind: ReferenceCollectionCandidate["referenceKind"];
  unit: ReferenceCollectionCandidate["unit"];
  matchedItems: number;
  totalItems: number;
}

const PROJECT_CATEGORIES: ProjectCategory[] = [
  "cli",
  "api",
  "web-app",
  "library",
  "platform",
  "mobile-app",
  "desktop-app",
  "framework",
  "monorepo",
  "other",
];

const PROJECT_PROFILES: ProjectProfile[] = [
  "cli",
  "api",
  "web-app",
  "docs-template",
  "library",
  "platform",
  "framework",
  "monorepo",
  "application",
  "fallback",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(stringValue)
    .filter((item): item is string => Boolean(item));
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

export function canonicalizeEndpointPath(path: string): string {
  return path.replace(/\/:([A-Za-z0-9_]+)/g, "/{$1}");
}

function normalizePackage(value: unknown): PackageInfo | undefined {
  if (typeof value === "string") {
    return { name: value, description: "" };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name);
  if (!name) return undefined;
  return {
    name,
    description: stringValue(record.description) ?? "",
  };
}

function normalizeCliCommand(value: unknown): CliCommand | undefined {
  if (typeof value === "string") {
    return { name: value, description: "" };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name) ?? stringValue(record.command);
  if (!name) return undefined;
  return {
    name,
    description: stringValue(record.description) ?? "",
    args: stringArray(record.args),
    options: stringArray(record.options),
    example: stringValue(record.example),
  };
}

function normalizeConfigFile(value: unknown): ConfigFile | undefined {
  if (typeof value === "string") {
    return { path: value.trim(), description: "" };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const path = stringValue(record.path) ?? stringValue(record.file) ?? stringValue(record.name);
  if (!path) return undefined;
  return {
    path,
    description: stringValue(record.description) ?? "",
    schema: stringValue(record.schema),
  };
}

function normalizeApiEndpoint(value: unknown): ApiEndpoint | undefined {
  if (typeof value === "string") {
    const match = value.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
    if (!match) return undefined;
    return {
      method: match[1].toUpperCase(),
      path: canonicalizeEndpointPath(match[2].trim()),
      description: "",
    };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const method = stringValue(record.method);
  const path = stringValue(record.path) ?? stringValue(record.route);
  if (!method || !path) return undefined;
  return {
    method: method.toUpperCase(),
    path: canonicalizeEndpointPath(path),
    description: stringValue(record.description) ?? "",
  };
}

function normalizeArray<T>(value: unknown, normalizeItem: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeItem)
    .filter((item): item is T => item !== undefined);
}

function normalizeEvidence(value: unknown): SourceEvidence | undefined {
  if (typeof value === "string") {
    return { path: value };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const path = stringValue(record.path) ?? stringValue(record.file);
  if (!path) return undefined;
  const kind = record.kind === "docs" ||
    record.kind === "readme" ||
    record.kind === "package" ||
    record.kind === "source" ||
    record.kind === "manifest" ||
    record.kind === "example" ||
    record.kind === "other"
    ? record.kind
    : undefined;
  return {
    path,
    kind,
    title: stringValue(record.title),
  };
}

function normalizeDocumentationCollectionItem(
  value: unknown,
): DocumentationCollectionItem | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = stringValue(record.id);
  const title = stringValue(record.title);
  const slug = stringValue(record.slug);
  if (!id || !title || !slug) return undefined;
  return {
    id,
    title,
    slug,
    description: stringValue(record.description),
    packageName: stringValue(record.packageName),
    installCommand: stringValue(record.installCommand),
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
  };
}

function normalizeDocumentationCollection(value: unknown): DocumentationCollection | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = stringValue(record.id);
  const title = stringValue(record.title);
  if (!id || !title) return undefined;
  const kind = record.kind === "package" ||
    record.kind === "manifest" ||
    record.kind === "mixed"
    ? record.kind
    : "docs";
  const items = normalizeArray(record.items, normalizeDocumentationCollectionItem);
  if (items.length === 0) return undefined;
  return {
    id,
    title,
    description: stringValue(record.description),
    kind,
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
    items,
  };
}

function normalizeSlug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "reference";
}

function normalizeRestEndpoint(value: unknown): RestApiReferenceEndpoint | undefined {
  const legacy = normalizeApiEndpoint(value);
  if (legacy && typeof value === "string") {
    const id = normalizeSlug(`${legacy.method}-${legacy.path}`);
    return {
      id,
      title: `${legacy.method} ${legacy.path}`,
      method: legacy.method,
      path: canonicalizeEndpointPath(legacy.path),
      description: legacy.description,
      sourceEvidence: [],
    };
  }

  const record = asRecord(value);
  if (!record) return undefined;
  const method = stringValue(record.method);
  const path = stringValue(record.path) ?? stringValue(record.route);
  if (!method || !path) return undefined;
  const normalizedMethod = method.toUpperCase();
  const id = stringValue(record.id) ?? normalizeSlug(`${normalizedMethod}-${path}`);
  return {
    id,
    title: stringValue(record.title) ?? `${normalizedMethod} ${path}`,
    method: normalizedMethod,
    path: canonicalizeEndpointPath(path),
    description: stringValue(record.description) ?? "",
    auth: stringValue(record.auth),
    requestSchema: stringValue(record.requestSchema),
    responseSchema: stringValue(record.responseSchema),
    errors: stringArray(record.errors),
    parameters: normalizeArray(record.parameters, normalizeRestParameter),
    bodyFields: normalizeArray(record.bodyFields, normalizeRestField),
    bodyContentType: stringValue(record.bodyContentType),
    responses: normalizeArray(record.responses, normalizeRestResponse),
    authRequirement: normalizeRestAuth(record.authRequirement),
    ...(record.deprecated === true ? { deprecated: true } : {}),
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
  };
}

function normalizeRestParameter(
  value: unknown,
): RestApiReferenceParameter | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name);
  const type = stringValue(record.type);
  const location = normalizeParameterLocation(record.in ?? record.location);
  if (!name || !type || !location) return undefined;
  return {
    name,
    in: location,
    type,
    required: booleanValue(record.required),
    description: stringValue(record.description),
    example: stringValue(record.example),
    enumValues: stringArray(record.enumValues),
  };
}

function normalizeParameterLocation(
  value: unknown,
): RestApiReferenceParameter["in"] | undefined {
  switch (value) {
    case "path": return "path";
    case "query": return "query";
    case "header": return "header";
    case "cookie": return "cookie";
    default: return undefined;
  }
}

function normalizeRestField(value: unknown): RestApiReferenceField | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name);
  const type = stringValue(record.type);
  if (!name || !type) return undefined;
  return {
    name,
    type,
    required: booleanValue(record.required),
    description: stringValue(record.description),
    example: stringValue(record.example),
  };
}

function normalizeRestResponse(
  value: unknown,
): RestApiReferenceResponse | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const status = typeof record.status === "number"
    ? record.status
    : Number(stringValue(record.status));
  const statusLabel = normalizeStatusLabel(record.statusLabel, status);
  // A spec `default` response has status 0 and the label "default".
  const validStatus = status === 0 ? statusLabel === "default" : status >= 100 && status <= 599;
  if (!Number.isInteger(status) || !validStatus) return undefined;
  return {
    status,
    ...(statusLabel ? { statusLabel } : {}),
    contentType: stringValue(record.contentType),
    description: stringValue(record.description),
    example: stringValue(record.example),
    fields: normalizeArray(record.fields, normalizeRestField),
  };
}

/** `2XX` with status 200, or `default` with status 0; any other label is dropped. */
function normalizeStatusLabel(value: unknown, status: number): string | undefined {
  if (value === "default") return status === 0 ? "default" : undefined;
  if (typeof value !== "string" || !/^[1-5]XX$/.test(value)) return undefined;
  return Number(value[0]) * 100 === status ? value : undefined;
}

function normalizeRestSource(value: unknown): RestApiReferenceSource | undefined {
  const record = asRecord(value);
  if (record?.kind !== "openapi") return undefined;
  const contentHash = stringValue(record.contentHash);
  const readerVersion = stringValue(record.readerVersion);
  if (!contentHash || !readerVersion) return undefined;
  return {
    kind: "openapi",
    specVersions: stringArray(record.specVersions),
    files: stringArray(record.files),
    contentHash,
    readerVersion,
  };
}

function normalizeRestExtraction(value: unknown): RestApiReferenceExtraction | undefined {
  const record = asRecord(value);
  const promptVersion = stringValue(record?.promptVersion);
  const model = stringValue(record?.model);
  if (!record || !promptVersion || !model) return undefined;
  return { promptVersion, model, files: stringArray(record.files) };
}

/** The report of the spec route; its contract schema drops unknown keys and rejects bad values. */
function normalizeReferenceSourceReport(value: unknown): ReferenceSourceReport | undefined {
  const result = referenceSourceReportSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function normalizeRestAuth(value: unknown): RestApiReferenceAuth | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const scheme = normalizeAuthScheme(record.scheme);
  if (!scheme) return undefined;
  return {
    scheme,
    location: normalizeAuthLocation(record.location),
    name: stringValue(record.name),
    description: stringValue(record.description),
  };
}

function normalizeRestPlayground(
  value: unknown,
): RestApiReferenceSurface["playground"] | undefined {
  const record = asRecord(value);
  if (!record || typeof record.enabled !== "boolean") return undefined;
  return {
    enabled: record.enabled,
    reason: stringValue(record.reason),
  };
}

function normalizeAuthScheme(
  value: unknown,
): RestApiReferenceAuth["scheme"] | undefined {
  switch (value) {
    case "bearer": return "bearer";
    case "apiKey": return "apiKey";
    case "basic": return "basic";
    case "oauth2": return "oauth2";
    case "none": return "none";
    default: return undefined;
  }
}

function normalizeAuthLocation(
  value: unknown,
): RestApiReferenceAuth["location"] {
  switch (value) {
    case "header": return "header";
    case "query": return "query";
    case "cookie": return "cookie";
    default: return undefined;
  }
}

function normalizeRestGroup(value: unknown): RestApiReferenceGroup | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const endpoints = normalizeArray(record.endpoints, normalizeRestEndpoint);
  if (endpoints.length === 0) return undefined;
  const title = stringValue(record.title) ?? "Endpoints";
  return {
    id: stringValue(record.id) ?? normalizeSlug(title),
    title,
    description: stringValue(record.description),
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
    endpoints,
  };
}

const SDK_EXPORT_KINDS: SdkReferenceExportKind[] = [
  "function",
  "class",
  "type",
  "interface",
  "hook",
  "constant",
  "component",
  "module",
  "other",
];

function normalizeSdkExportKind(value: unknown): SdkReferenceExportKind {
  return SDK_EXPORT_KINDS.includes(value as SdkReferenceExportKind)
    ? value as SdkReferenceExportKind
    : "other";
}

function normalizeSdkExport(value: unknown): SdkApiReferenceExport | undefined {
  if (typeof value === "string") {
    return {
      id: normalizeSlug(value),
      name: value,
      kind: "other",
      description: "",
      sourceEvidence: [],
    };
  }

  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name) ?? stringValue(record.exportName);
  if (!name) return undefined;
  return {
    id: stringValue(record.id) ?? normalizeSlug(name),
    name,
    kind: normalizeSdkExportKind(record.kind ?? record.exportKind),
    description: stringValue(record.description) ?? "",
    signature: stringValue(record.signature),
    importPath: stringValue(record.importPath),
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
  };
}

function normalizeSdkModule(value: unknown): SdkApiReferenceModule | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const exports = normalizeArray(record.exports, normalizeSdkExport);
  if (exports.length === 0) return undefined;
  const title = stringValue(record.title) ??
    stringValue(record.name) ??
    stringValue(record.importPath) ??
    "Exports";
  return {
    id: stringValue(record.id) ?? normalizeSlug(title),
    title,
    description: stringValue(record.description),
    packageName: stringValue(record.packageName),
    importPath: stringValue(record.importPath),
    sourceEvidence: normalizeArray(record.sourceEvidence, normalizeEvidence),
    exports,
  };
}

function normalizeReferenceSurfaces(value: unknown): ProjectReferenceSurfaces | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const restRecord = asRecord(record.rest);
  const sdkRecord = asRecord(record.sdk);
  const surfaces: ReferenceSurfaces = {};

  if (restRecord) {
    const groups = normalizeArray(restRecord.groups, normalizeRestGroup);
    const source = normalizeRestSource(restRecord.source);
    const extraction = normalizeRestExtraction(restRecord.extraction);
    if (groups.length > 0) {
      surfaces.rest = {
        ...(source ? { source } : {}),
        ...(extraction ? { extraction } : {}),
        label: stringValue(restRecord.label),
        slug: stringValue(restRecord.slug),
        description: stringValue(restRecord.description),
        sourceEvidence: normalizeArray(restRecord.sourceEvidence, normalizeEvidence),
        baseUrl: stringValue(restRecord.baseUrl),
        servers: stringArray(restRecord.servers),
        authSchemes: normalizeArray(restRecord.authSchemes, normalizeRestAuth),
        playground: normalizeRestPlayground(restRecord.playground),
        groups,
      };
    }
  }

  if (sdkRecord) {
    const modules = normalizeArray(sdkRecord.modules, normalizeSdkModule);
    if (modules.length > 0) {
      surfaces.sdk = {
        label: stringValue(sdkRecord.label),
        slug: stringValue(sdkRecord.slug),
        description: stringValue(sdkRecord.description),
        sourceEvidence: normalizeArray(sdkRecord.sourceEvidence, normalizeEvidence),
        modules,
      };
    }
  }

  return surfaces.rest || surfaces.sdk ? surfaces : undefined;
}

const GENERIC_REFERENCE_TITLE_TOKENS = new Set([
  "api",
  "rest",
  "rpc",
  "reference",
  "resource",
  "group",
  "module",
]);

function comparisonTitleTokens(title: string): Set<string> {
  const normalized = normalizeSlug(title).split("-");
  const meaningful = normalized
    .map((token) => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)
    .filter((token) => !GENERIC_REFERENCE_TITLE_TOKENS.has(token));
  return new Set(meaningful.length > 0 ? meaningful : normalized);
}

function titlesSubstantiallyMatch(first: string, second: string): boolean {
  const firstTokens = comparisonTitleTokens(first);
  const secondTokens = comparisonTitleTokens(second);
  if (firstTokens.size === 0 || secondTokens.size === 0) return false;

  const sharedTokens = Array.from(firstTokens).filter((token) => secondTokens.has(token)).length;
  const combinedTitleSize = firstTokens.size + secondTokens.size - sharedTokens;
  return sharedTokens / combinedTitleSize >= 0.75;
}

function normalizedEvidencePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function uniqueEvidencePaths(evidence: SourceEvidence[]): string[] {
  return Array.from(new Set(
    evidence
      .map((item) => normalizedEvidencePath(item.path))
      .filter(Boolean),
  ));
}

function sourcePathsOverlap(first: string[], second: string[]): boolean {
  return first.some((firstPath) => second.some((secondPath) =>
    firstPath === secondPath ||
    firstPath.startsWith(`${secondPath}/`) ||
    secondPath.startsWith(`${firstPath}/`),
  ));
}

function referenceCollectionCandidates(
  surfaces: ProjectReferenceSurfaces,
): ReferenceCollectionCandidate[] {
  const restCandidates = surfaces.rest?.groups.map((group) => ({
    referenceKind: "REST API" as const,
    unit: "groups" as const,
    id: group.id,
    title: group.title,
    sourcePaths: uniqueEvidencePaths([
      ...(surfaces.rest?.sourceEvidence ?? []),
      ...group.sourceEvidence,
      ...group.endpoints.flatMap((endpoint) => endpoint.sourceEvidence),
    ]),
  })) ?? [];
  const sdkCandidates = surfaces.sdk?.modules.map((module) => ({
    referenceKind: "SDK API" as const,
    unit: "modules" as const,
    id: module.id,
    title: module.title,
    sourcePaths: uniqueEvidencePaths([
      ...(surfaces.sdk?.sourceEvidence ?? []),
      ...module.sourceEvidence,
      ...module.exports.flatMap((item) => item.sourceEvidence),
    ]),
  })) ?? [];
  return [...restCandidates, ...sdkCandidates];
}

function referenceCollectionOverlap(
  collection: DocumentationCollection,
  candidates: ReferenceCollectionCandidate[],
): ReferenceCollectionOverlap | undefined {
  const candidatesByKind = new Map<ReferenceCollectionCandidate["referenceKind"], ReferenceCollectionCandidate[]>();
  for (const candidate of candidates) {
    const existing = candidatesByKind.get(candidate.referenceKind) ?? [];
    existing.push(candidate);
    candidatesByKind.set(candidate.referenceKind, existing);
  }

  for (const [referenceKind, matchingCandidates] of candidatesByKind) {
    const usedCandidateIds = new Set<string>();
    const matchedItems = [...collection.items]
      .sort((first, second) => first.id.localeCompare(second.id))
      .filter((item) => {
        const itemPaths = uniqueEvidencePaths([
          ...collection.sourceEvidence,
          ...item.sourceEvidence,
        ]);
        const match = matchingCandidates
          .filter((candidate) => !usedCandidateIds.has(candidate.id))
          .sort((first, second) => first.id.localeCompare(second.id))
          .find((candidate) =>
            titlesSubstantiallyMatch(item.title, candidate.title) &&
            sourcePathsOverlap(itemPaths, candidate.sourcePaths),
          );
        if (!match) return false;
        usedCandidateIds.add(match.id);
        return true;
      }).length;
    const completeSmallCollection = collection.items.length <= 2 &&
      matchedItems === collection.items.length;
    const substantiallyOverlappingCollection = collection.items.length > 2 &&
      matchedItems >= Math.ceil(collection.items.length * 0.75) &&
      matchedItems >= 3;
    if (completeSmallCollection || substantiallyOverlappingCollection) {
      return {
        referenceKind,
        unit: matchingCandidates[0]?.unit ?? "groups",
        matchedItems,
        totalItems: collection.items.length,
      };
    }
  }

  return undefined;
}

function removeReferenceDuplicateCollections(
  collections: DocumentationCollection[],
  surfaces: ProjectReferenceSurfaces,
): DocumentationCollection[] {
  const candidates = referenceCollectionCandidates(surfaces);
  if (candidates.length === 0) return collections;

  return collections.filter((collection) => {
    const overlap = referenceCollectionOverlap(collection, candidates);
    if (!overlap) return true;

    console.warn(
      `[analysis-normalizer] Dropped documentation collection "${collection.title}" because its items overlap ${overlap.referenceKind} reference ${overlap.unit} by title and source evidence paths (${overlap.matchedItems}/${overlap.totalItems} items).`,
    );
    return false;
  });
}

function normalizePublicInterfaces(value: unknown): ProjectAnalysis["publicInterfaces"] {
  const record = asRecord(value);
  if (!record) return undefined;

  return {
    cliCommands: normalizeArray(record.cliCommands, normalizeCliCommand),
    apiEndpoints: normalizeArray(record.apiEndpoints, normalizeApiEndpoint),
    exports: stringArray(record.exports),
    routes: stringArray(record.routes),
  };
}

function normalizeInternalTooling(value: unknown): ProjectAnalysis["internalTooling"] {
  const record = asRecord(value);
  if (!record) return undefined;

  return {
    packageScripts: stringArray(record.packageScripts),
    buildTools: stringArray(record.buildTools),
  };
}

function normalizeAudience(value: unknown): DocumentationIntent["audience"] {
  return value === "maintainer" || value === "mixed" ? value : "consumer";
}

function normalizeCanonicalWorkflow(value: unknown): CanonicalWorkflow | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = stringValue(record.name);
  if (!name) return undefined;

  return {
    name,
    framework: stringValue(record.framework),
    installCommands: stringArray(record.installCommands),
    requiredFiles: stringArray(record.requiredFiles),
    canonicalImports: stringArray(record.canonicalImports),
    envVars: stringArray(record.envVars),
    routePaths: stringArray(record.routePaths),
    verificationSteps: stringArray(record.verificationSteps),
    sourceEvidence: stringArray(record.sourceEvidence),
  };
}

function normalizeDocumentationIntent(value: unknown): DocumentationIntent {
  const record = asRecord(value) ?? {};
  return {
    audience: normalizeAudience(record.audience),
    primaryUseCase: stringValue(record.primaryUseCase) ?? "",
    publicPackageNames: stringArray(record.publicPackageNames),
    canonicalWorkflows: normalizeArray(record.canonicalWorkflows, normalizeCanonicalWorkflow),
    internalOnlyPaths: stringArray(record.internalOnlyPaths),
    consumerTerminology: stringArray(record.consumerTerminology),
  };
}

function normalizePublicEditorialBrief(value: unknown): PublicEditorialBrief | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const productPositioning = stringValue(record.productPositioning);
  const preferredTone = stringValue(record.preferredTone);
  const brief: PublicEditorialBrief = {
    intendedReaders: stringArray(record.intendedReaders),
    readerGoals: stringArray(record.readerGoals),
    focusAreas: stringArray(record.focusAreas),
    deprioritizedAreas: stringArray(record.deprioritizedAreas),
    preferredTerminology: stringArray(record.preferredTerminology),
    ...(productPositioning ? { productPositioning } : {}),
    ...(preferredTone ? { preferredTone } : {}),
  };

  return productPositioning ||
      preferredTone ||
      brief.intendedReaders.length ||
      brief.readerGoals.length ||
      brief.focusAreas.length ||
      brief.deprioritizedAreas.length ||
      brief.preferredTerminology.length
    ? brief
    : undefined;
}

/**
 * Normalizes model- and cache-sourced project analysis before consumers see it.
 *
 * LLMs sometimes return plausible JSON with malformed array entries. This
 * boundary keeps prompt builders, dynamic questions, and writer context safe.
 */
export function normalizeProjectAnalysis(input: unknown): ProjectAnalysis {
  const record = asRecord(input) ?? {};
  const projectCategory = PROJECT_CATEGORIES.includes(record.projectCategory as ProjectCategory)
    ? record.projectCategory as ProjectCategory
    : "other";
  const projectProfile = PROJECT_PROFILES.includes(record.projectProfile as ProjectProfile)
    ? record.projectProfile as ProjectProfile
    : undefined;

  const summary = stringValue(record.summary) ?? "";
  const publicInterfaces = normalizePublicInterfaces(record.publicInterfaces);
  const apiEndpoints = normalizeArray(record.apiEndpoints, normalizeApiEndpoint);
  const referenceSurfaces = normalizeReferenceSurfaces(record.referenceSurfaces);
  const legacySdkModules = publicInterfaces?.exports?.length
    ? [{
        id: "exports",
        title: "Exports",
        sourceEvidence: [],
        exports: publicInterfaces.exports.map((name) => ({
          id: normalizeSlug(name),
          name,
          kind: "other" as const,
          description: "",
          sourceEvidence: [],
        })),
      }]
    : [];
  const mergedReferenceSurfaces: ProjectReferenceSurfaces = {
    ...(referenceSurfaces ?? {}),
    ...(!referenceSurfaces?.sdk && legacySdkModules.length > 0 ? {
      sdk: {
        label: "API Reference",
        slug: "api-reference",
        sourceEvidence: [],
        modules: legacySdkModules,
      },
    } : {}),
  };
  const hasReferenceSurfaces = Boolean(mergedReferenceSurfaces.rest || mergedReferenceSurfaces.sdk);
  const documentationCollections = normalizeArray(
    record.documentationCollections,
    normalizeDocumentationCollection,
  );

  return {
    projectName: stringValue(record.projectName) ?? "Unknown Project",
    projectType: stringValue(record.projectType) ?? "Unknown",
    languages: stringArray(record.languages),
    frameworks: stringArray(record.frameworks),
    entryPoints: stringArray(record.entryPoints),
    keyFiles: stringArray(record.keyFiles),
    summary,
    projectDescription: stringValue(record.projectDescription) ?? summary,
    projectCategory,
    projectProfile,
    profileConfidence: typeof record.profileConfidence === "number" ? record.profileConfidence : undefined,
    profileEvidence: Array.isArray(record.profileEvidence) ? stringArray(record.profileEvidence) : undefined,
    publicInterfaces,
    internalTooling: normalizeInternalTooling(record.internalTooling),
    documentationIntent: normalizeDocumentationIntent(record.documentationIntent),
    publicEditorialBrief: normalizePublicEditorialBrief(record.publicEditorialBrief),
    isMonorepo: booleanValue(record.isMonorepo),
    hasReact: booleanValue(record.hasReact),
    hasApiRoutes: booleanValue(record.hasApiRoutes),
    hasCli: booleanValue(record.hasCli),
    packages: normalizeArray(record.packages, normalizePackage),
    cliCommands: normalizeArray(record.cliCommands, normalizeCliCommand),
    configFiles: normalizeArray(record.configFiles, normalizeConfigFile),
    apiEndpoints,
    keyFeatures: stringArray(record.keyFeatures),
    installMethods: stringArray(record.installMethods),
    externalIntegrations: stringArray(record.externalIntegrations),
    documentationCollections: hasReferenceSurfaces
      ? removeReferenceDuplicateCollections(documentationCollections, mergedReferenceSurfaces)
      : documentationCollections,
    referenceSurfaces: hasReferenceSurfaces ? mergedReferenceSurfaces : undefined,
    referenceSourceReport: normalizeReferenceSourceReport(record.referenceSourceReport),
  };
}
