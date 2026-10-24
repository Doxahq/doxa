import type { DocumentationStructure, PageReferenceMetadata, ProjectAnalysis, SdkReferenceExportKind } from "../types";
import type { SourceEvidence } from "../types";
import { normalizeProjectAnalysis } from "../utils/analysis-normalizer";

function extractJSON(text: string): string | null {
  if (!text || typeof text !== "string") return null;

  // Strip any MDX/HTML/JSX component tags that the model might hallucinate
  // (e.g., <Mermaid>, <Card>, <Steps>, etc.)
  const cleaned = text
    .replace(/<[A-Z][a-zA-Z]*[\s\S]*?\/>/g, "")  // self-closing JSX tags
    .replace(/<[A-Z][a-zA-Z]*[\s\S]*?>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, "")  // paired JSX tags
    .trim();

  // Try code block extraction first
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const content = codeBlockMatch[1].trim();
    if (content.startsWith("{") && tryParse(content)) return content;
  }

  // Try first { to last } — validate it actually parses
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    if (tryParse(candidate)) return candidate;
  }

  // Fallback: scan for the longest valid JSON substring starting with {
  // This handles cases where non-JSON content surrounds the JSON object
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    // Try progressively shorter substrings from this start
    for (let end = text.length; end > start; end--) {
      if (text[end - 1] !== "}") continue;
      const candidate = text.slice(start, end);
      if (tryParse(candidate)) return candidate;
      break; // Only try the first matching } from the end for each {
    }
  }

  return null;
}

function tryParse(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function sanitizeString(str: string): string {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n/g, " ")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeEvidence(value: unknown): SourceEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SourceEvidence[] => {
    if (typeof item === "string") return [{ path: sanitizeString(item) }].filter((evidence) => evidence.path);
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? sanitizeString(record.path) : "";
    if (!path) return [];
    const title = typeof record.title === "string" ? sanitizeString(record.title) : undefined;
    const kind = record.kind === "docs" ||
      record.kind === "readme" ||
      record.kind === "package" ||
      record.kind === "source" ||
      record.kind === "manifest" ||
      record.kind === "example" ||
      record.kind === "other"
      ? record.kind
      : undefined;
    return [{ path, kind, title }];
  });
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

function sanitizeReference(value: unknown): PageReferenceMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind === "rest" || record.kind === "sdk" ? record.kind : undefined;
  if (!kind) return undefined;
  const exportKind = SDK_EXPORT_KINDS.includes(record.exportKind as SdkReferenceExportKind)
    ? record.exportKind as SdkReferenceExportKind
    : undefined;
  return {
    kind,
    groupId: optionalString(record.groupId),
    endpointId: optionalString(record.endpointId),
    moduleId: optionalString(record.moduleId),
    exportId: optionalString(record.exportId),
    method: optionalString(record.method)?.toUpperCase(),
    path: optionalString(record.path),
    exportName: optionalString(record.exportName),
    exportKind,
  };
}

/** An empty or blank string carries no value, as if the field were missing. */
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? sanitizeString(value) || undefined : undefined;
}

function validateStructure(structure: unknown): DocumentationStructure {
  if (!structure || typeof structure !== "object" || Array.isArray(structure)) {
    return { sections: [] };
  }
  const s = structure as Record<string, unknown>;
  if (!Array.isArray(s.sections)) return { sections: [] };

  const sections = s.sections.flatMap((value, sIdx) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const section = value as Record<string, unknown>;
    const rawPages = Array.isArray(section.pages) ? section.pages : [];
    const pages = rawPages.flatMap((pageValue, pIdx) => {
      if (!pageValue || typeof pageValue !== "object" || Array.isArray(pageValue)) return [];
      const page = pageValue as Record<string, unknown>;
      const pageId = sanitizeString(typeof page.id === "string" ? page.id : "") ||
        `page-${sIdx}-${pIdx}`;
      const pageTitle = sanitizeString(typeof page.title === "string" ? page.title : "") ||
        `Page ${pIdx + 1}`;
      const common = {
        sourceEvidence: sanitizeEvidence(page.sourceEvidence),
        collectionId: sanitizeString(typeof page.collectionId === "string" ? page.collectionId : "") || undefined,
        collectionItemId: sanitizeString(typeof page.collectionItemId === "string" ? page.collectionItemId : "") || undefined,
        group: sanitizeString(typeof page.group === "string" ? page.group : "") || undefined,
        reference: sanitizeReference(page.reference),
      };
      const parent = {
        id: pageId,
        title: pageTitle,
        description: sanitizeString(typeof page.description === "string" ? page.description : ""),
        ...common,
      };
      const children = Array.isArray(page.subPages)
        ? page.subPages.flatMap((childValue, spIdx) => {
            if (!childValue || typeof childValue !== "object" || Array.isArray(childValue)) return [];
            const child = childValue as Record<string, unknown>;
            const childId = sanitizeString(typeof child.id === "string" ? child.id : "") ||
              `page-${sIdx}-${pIdx}-${spIdx}`;
            return [{
              id: `${pageId}/${childId}`,
              title: sanitizeString(typeof child.title === "string" ? child.title : "") ||
                `Page ${pIdx + 1}.${spIdx + 1}`,
              description: sanitizeString(typeof child.description === "string" ? child.description : ""),
              sourceEvidence: sanitizeEvidence(child.sourceEvidence),
              collectionId: common.collectionId,
              collectionItemId: sanitizeString(
                typeof child.collectionItemId === "string" ? child.collectionItemId : "",
              ) || undefined,
              group: common.group ?? pageTitle,
              reference: sanitizeReference(child.reference),
            }];
          })
        : [];
      return [parent, ...children];
    });

    return [{
      id: sanitizeString(typeof section.id === "string" ? section.id : "") || `section-${sIdx}`,
      title: sanitizeString(typeof section.title === "string" ? section.title : "") || `Section ${sIdx + 1}`,
      pages,
      ...(section.default === true ? { default: true } : {}),
    }];
  });

  // Ensure exactly one section is marked default. If the agent omitted the
  // flag, fall back to the first section. If multiple sections set it,
  // keep only the first occurrence.
  const firstDefaultIdx = sections.findIndex((section) => section.default === true);
  if (firstDefaultIdx === -1 && sections.length > 0) {
    sections[0] = { ...sections[0], default: true };
  } else if (firstDefaultIdx >= 0) {
    sections.forEach((section, idx) => {
      if (idx !== firstDefaultIdx && section.default) {
        delete (section as { default?: boolean }).default;
      }
    });
  }

  return { sections };
}

export function parseProjectAnalysis(text: string): ProjectAnalysis {
  if (!text || text.trim().length === 0) {
    throw new Error("Analysis result is empty — the agent did not return any content");
  }

  const jsonString = extractJSON(text);
  if (!jsonString) {
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`Could not find JSON in analysis result. Received: ${preview}`);
  }

  try {
    const parsed = JSON.parse(jsonString);
    if (!parsed.projectName) {
      throw new Error("Invalid analysis result — missing projectName");
    }

    return normalizeProjectAnalysis(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const preview = jsonString.length > 300 ? jsonString.slice(0, 300) + "..." : jsonString;
      throw new Error(`Invalid JSON in analysis result: ${error.message}. Content: ${preview}`);
    }
    throw error;
  }
}

export function parseStructureResult(text: string): DocumentationStructure {
  if (!text || text.trim().length === 0) {
    throw new Error("Structure result is empty — the agent did not return any content");
  }

  const jsonString = extractJSON(text);
  if (!jsonString) {
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`Could not find JSON in structure result. Received: ${preview}`);
  }

  try {
    const parsed = JSON.parse(jsonString);
    return validateStructure(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const preview = jsonString.length > 300 ? jsonString.slice(0, 300) + "..." : jsonString;
      throw new Error(`Invalid JSON in structure result: ${error.message}. Content: ${preview}`);
    }
    throw error;
  }
}
