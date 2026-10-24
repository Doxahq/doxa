import { z } from "zod";
import {
  DOCS_PAGE_SLUG_PATTERN,
  DOCS_SECTION_SLUG_PATTERN,
} from "./docs-content";
import { docsAssetNameFromArtifactPath } from "./docs-assets";
import { createValidationIssue } from "./validation-messages";
import type { ValidationIssue } from "./validation";

const RESERVED_BRANCH_NAMES = new Set([
  "main",
  "head",
  "hidden",
  "preview",
  "draft",
]);
const BRANCH_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function branchNameIssueCode(
  name: string,
): "invalid_branch_name" | "reserved_branch_name" | null {
  if (!BRANCH_NAME_PATTERN.test(name) || name.includes("--"))
    return "invalid_branch_name";
  if (RESERVED_BRANCH_NAMES.has(name)) return "reserved_branch_name";
  return null;
}

export const branchNameSchema = z.string().superRefine((name, context) => {
  const code = branchNameIssueCode(name);
  if (code) context.addIssue({ code: "custom", message: code });
});

export function validateBranchName(input: unknown): ValidationIssue[] {
  if (typeof input !== "string")
    return [createValidationIssue("invalid_branch_name", "/name")];
  const code = branchNameIssueCode(input);
  return code ? [createValidationIssue(code, "/name")] : [];
}

export const branchRefSchema = z.union([z.literal("main"), z.uuid()]);
export const branchIdSchema = z.uuid().brand<"BranchId">();
export const siteIdSchema = z.uuid().brand<"SiteId">();
export const versionIdSchema = z.uuid().brand<"VersionId">();
export const docsBranchKindSchema = z.enum(["named", "hidden"]);
export const docsBranchPurposeSchema = z.enum([
  "user",
  "generation_review",
  "generation_backup",
]);
export const docsBranchChangeKindSchema = z.enum(["upsert", "delete"]);
export const docsPublicationKindSchema = z.enum([
  "import",
  "generation",
  "starter",
  "editor",
  "promotion",
  "restore",
]);

const pageSourcePathPattern = /^source\/(?:([a-z0-9/-]+)\/)?index\.mdx$/;
const sectionDocumentsPathPattern = /^settings\/documents\.([^.]+)\.json$/;

export function relativeNavigationPathForSection(slug: string): string {
  if (slug !== "default" && !DOCS_SECTION_SLUG_PATTERN.test(slug)) {
    throw new Error("Invalid section slug");
  }
  return slug === "default"
    ? "settings/documents.json"
    : `settings/documents.${slug}.json`;
}

export function documentSectionSlugFromRelativePath(
  path: string,
): string | null {
  if (path === "settings/documents.json") return "default";
  return sectionDocumentsPathPattern.exec(path)?.[1] ?? null;
}

export const branchPathSchema = z.string().refine((path) => {
  if (
    path === "source/index.mdx" ||
    path === "manifest.json" ||
    path === "settings/sections.json" ||
    path === "settings/documents.json" ||
    path === "settings/site.json"
  ) {
    return true;
  }

  if (docsAssetNameFromArtifactPath(path)) return true;

  const page = pageSourcePathPattern.exec(path);
  if (page?.[1] && DOCS_PAGE_SLUG_PATTERN.test(page[1])) return true;

  const sectionSlug = documentSectionSlugFromRelativePath(path);
  return Boolean(sectionSlug && DOCS_SECTION_SLUG_PATTERN.test(sectionSlug));
}, "invalid_branch_path");

/**
 * What a changed path is. An asset change holds a pointer to an uploaded
 * file, not the file itself (see `services/docs-branches/assets`).
 */
export type BranchPathKind = "page" | "structure" | "site_settings" | "asset";

export function classifyBranchPath(
  path: z.infer<typeof branchPathSchema>,
): BranchPathKind {
  if (!branchPathSchema.safeParse(path).success) {
    throw new Error("Invalid branch path");
  }
  if (path.startsWith("source/")) return "page";
  if (path.startsWith("assets/")) return "asset";
  if (path === "settings/site.json") return "site_settings";
  return "structure";
}
