import { relative } from "path";
import type {
  DocsQualityIssue,
  DocsQualityReport,
  DocumentationStructure,
  GeneratedPageContent,
  ProjectAnalysis,
} from "../types";
import { parseFrontmatter, stripAllFrontmatter } from "./frontmatter";
import { normalizeProjectAnalysis } from "./analysis-normalizer";
import { collectionsWithPages } from "./documentation-collection-policy";
import { flattenStructure } from "../doxa-agent/structure-utils";
import {
  buildRouteRegistry,
  closestGeneratedRoutes,
  normalizeRoute,
  routeFromOutputPath,
  type RouteRegistry,
} from "../doxa-agent/route-registry";
import {
  isQuickstartPage,
  validateQuickstartQuality,
} from "./quickstart-quality-validator";
import { hasUnbalancedPunctuation } from "./title-validation";
import { findRestEndpointDuplicateSection } from "./rest-endpoint-sections";

export interface DocsQualityValidationOptions {
  outputDir: string;
  structure: DocumentationStructure;
  analysis?: ProjectAnalysis;
  requireAllStructurePages?: boolean;
  ignoredMissingRoutes?: string[];
  failOnWarnings?: boolean;
  routeRegistry?: RouteRegistry;
  /**
   * Allow links to planned structure routes even when the linked page is not
   * part of the current generated page subset. This is for partial generation
   * flows such as /test-generate; full generation keeps validating against
   * actually written pages.
   */
  allowStructureRoutesForLinks?: boolean;
}

const INTERNAL_LEAK_PATTERNS: Array<{ rule: string; regex: RegExp; message: string }> = [
  {
    rule: "consumer-internal-path",
    regex: /(?<![\w-])(?:apps\/dev|packages\/|fixtures\/|__tests__\/|\.github\/|playwright\.config|e2e\/)/i,
    message: "Consumer docs mention repo-internal paths or test fixtures.",
  },
  {
    rule: "consumer-dev-script",
    regex: /\b(?:pnpm|bun|npm|yarn)\s+(?:run\s+)?(?:dev|test|lint|typecheck|format)\b/i,
    message: "Consumer docs present local contributor scripts as user setup.",
  },
  {
    rule: "consumer-test-credential",
    regex: /\b(?:test@example\.com|password123?|debug:\s*true|unstable_[A-Za-z0-9_]+)\b/i,
    message: "Consumer docs include demo credentials, debug defaults, or unstable APIs.",
  },
];

const PLACEHOLDER_REGEX = /\b(?:Section overview pending|TODO|TBD|coming soon|placeholder text)\b/i;

export function validateGeneratedDocs(
  pages: GeneratedPageContent[],
  options: DocsQualityValidationOptions,
): DocsQualityReport {
  const issues: DocsQualityIssue[] = [];
  const routeRegistry = options.routeRegistry ?? buildRouteRegistry(options.structure);
  const routeSet = buildGeneratedRouteSet(pages, options.outputDir);
  const pageByRoute = buildGeneratedPageMap(pages, options.outputDir);
  const restEndpointRoutes = buildRestEndpointRouteSet(options.structure);
  const normalizedAnalysis = options.analysis ? normalizeProjectAnalysis(options.analysis) : undefined;
  const audience = normalizedAnalysis?.documentationIntent?.audience ?? "consumer";

  for (const page of pages) {
    const route = routeFromGeneratedPath(page.path, options.outputDir);
    const body = stripAllFrontmatter(page.content);
    const { frontmatter } = parseFrontmatter(page.content);
    const title = typeof frontmatter?.title === "string" ? frontmatter.title : page.title;
    const pageAudience = inferPageAudience(page.title, route, audience);

    if (hasUnbalancedPunctuation(title)) {
      issues.push({
        rule: "malformed-title",
        severity: "error",
        title: page.title,
        route,
        message: `Frontmatter title has unbalanced punctuation: ${title}`,
      });
    }

    if (PLACEHOLDER_REGEX.test(body)) {
      issues.push({
        rule: "placeholder-content",
        severity: "error",
        title: page.title,
        route,
        message: "Page contains placeholder or unfinished content.",
      });
    }

    if (restEndpointRoutes.has(route)) {
      const duplicateSection = findRestEndpointDuplicateSection(body);
      if (duplicateSection) {
        issues.push({
          rule: "rest-endpoint-duplicate-section",
          severity: "error",
          title: page.title,
          route,
          line: duplicateSection.line + 1,
          message:
            `REST endpoint page repeats the renderer-owned section "${duplicateSection.heading}".`,
          excerpt: duplicateSection.source,
        });
      }
    }

    for (const link of extractInternalLinks(body)) {
      if (!routeSet.has(link)) {
        const aliasTarget = routeRegistry.aliasToRoute.get(link);
        const structureTarget = routeRegistry.routeSet.has(link) ? link : aliasTarget;
        if (options.allowStructureRoutesForLinks && structureTarget && routeRegistry.routeSet.has(structureTarget)) {
          continue;
        }

        const suggestions = aliasTarget ? [aliasTarget] : closestGeneratedRoutes(link, routeRegistry);
        issues.push({
          rule: "unresolved-internal-link",
          severity: "error",
          title: page.title,
          route,
          message: `Internal link does not resolve to a generated page: ${link}${suggestions.length ? `. Suggested generated route: ${suggestions.join(", ")}` : ""}`,
          excerpt: link,
        });
      }
    }

    if (pageAudience === "consumer") {
      const prose = maskRouteDestinations(body, routeRegistry);
      for (const pattern of INTERNAL_LEAK_PATTERNS) {
        const match = findLineMatch(prose, pattern.regex, body);
        if (match) {
          issues.push({
            rule: pattern.rule,
            severity: "error",
            title: page.title,
            route,
            line: match.line,
            message: pattern.message,
            excerpt: match.excerpt,
          });
        }
      }
    }

    if (isQuickstartPage(title, route)) {
      validateQuickstartQuality({
        title: page.title,
        route,
        body,
        analysis: normalizedAnalysis,
        issues,
      });
    }
  }

  if (options.requireAllStructurePages) {
    const expectedRoutes = buildExpectedRouteSet(options.structure);
    const ignoredMissingRoutes = new Set((options.ignoredMissingRoutes ?? []).map(normalizeRoute));
    for (const route of expectedRoutes) {
      if (ignoredMissingRoutes.has(route)) continue;
      if (!routeSet.has(route)) {
        issues.push({
          rule: "missing-generated-page",
          severity: "error",
          route,
          message: `Expected structure page was not generated: ${route}`,
        });
      }
    }
  }

  if (normalizedAnalysis?.documentationCollections?.length) {
    validateCollectionCoverage({
      analysis: normalizedAnalysis,
      structure: options.structure,
      routeSet,
      pageByRoute,
      ignoredMissingRoutes: new Set((options.ignoredMissingRoutes ?? []).map(normalizeRoute)),
      requireAllStructureRoutes: options.requireAllStructurePages === true,
      issues,
    });
  }

  if (normalizedAnalysis?.referenceSurfaces) {
    validateReferenceCoverage({
      analysis: normalizedAnalysis,
      structure: options.structure,
      routeSet,
      ignoredMissingRoutes: new Set((options.ignoredMissingRoutes ?? []).map(normalizeRoute)),
      requireAllStructureRoutes: options.requireAllStructurePages === true,
      issues,
    });
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  const hasWarning = issues.some((issue) => issue.severity === "warning");
  return {
    ok: !hasError && (!options.failOnWarnings || !hasWarning),
    issues,
  };
}

interface ReferenceCoverageContext {
  analysis: ProjectAnalysis;
  structure: DocumentationStructure;
  routeSet: Set<string>;
  ignoredMissingRoutes: Set<string>;
  requireAllStructureRoutes: boolean;
  issues: DocsQualityIssue[];
}

function validateReferenceCoverage(context: ReferenceCoverageContext): void {
  const targets = flattenStructure(context.structure);
  for (const group of context.analysis.referenceSurfaces?.rest?.groups ?? []) {
    for (const endpoint of group.endpoints) {
      const target = targets.find((candidate) =>
          candidate.page.reference?.kind === "rest" &&
          candidate.page.reference.groupId === group.id &&
          candidate.page.reference.endpointId === endpoint.id
        ) ??
        targets.find((candidate) =>
          candidate.page.reference?.kind === "rest" &&
          candidate.page.reference.groupId === group.id &&
          candidate.page.reference.endpointId === endpoint.id
        );
      if (!target) {
        context.issues.push({
          rule: "missing-rest-reference-page",
          severity: "error",
          message: `REST API endpoint ${endpoint.method} ${endpoint.path} is missing a reference page.`,
        });
        continue;
      }
      const route = routeFromTargetPath(target.path);
      if (
        context.requireAllStructureRoutes &&
        !context.ignoredMissingRoutes.has(route) &&
        !context.routeSet.has(route)
      ) {
        context.issues.push({
          rule: "missing-rest-reference-route",
          severity: "error",
          route,
          message: `REST API endpoint ${endpoint.method} ${endpoint.path} did not generate route ${route}.`,
        });
      }
    }
  }

  for (const module of context.analysis.referenceSurfaces?.sdk?.modules ?? []) {
    const moduleTarget = targets.find((candidate) =>
      candidate.page.reference?.kind === "sdk" &&
      candidate.page.reference.moduleId === module.id &&
      candidate.page.reference.exportId === undefined
    );
    for (const entry of module.exports) {
      const target = moduleTarget ?? targets.find((candidate) =>
        candidate.page.reference?.kind === "sdk" &&
        candidate.page.reference.exportId === entry.id
      );
      if (!target) {
        context.issues.push({
          rule: "missing-sdk-reference-page",
          severity: "error",
          message: `SDK export ${entry.name} is missing an API Reference page.`,
        });
        continue;
      }
      const route = routeFromTargetPath(target.path);
      if (
        context.requireAllStructureRoutes &&
        !context.ignoredMissingRoutes.has(route) &&
        !context.routeSet.has(route)
      ) {
        context.issues.push({
          rule: "missing-sdk-reference-route",
          severity: "error",
          route,
          message: `SDK export ${entry.name} did not generate route ${route}.`,
        });
      }
    }
  }
}

interface CollectionCoverageContext {
  analysis: ProjectAnalysis;
  structure: DocumentationStructure;
  routeSet: Set<string>;
  pageByRoute: Map<string, GeneratedPageContent>;
  ignoredMissingRoutes: Set<string>;
  requireAllStructureRoutes: boolean;
  issues: DocsQualityIssue[];
}

function validateCollectionCoverage(context: CollectionCoverageContext): void {
  const targets = flattenStructure(context.structure);
  for (const collection of collectionsWithPages(context.analysis)) {
    const collectionTargets = targets.filter(
      (target) => target.page.collectionId === collection.id,
    );
    if (collectionTargets.length === 0) {
      context.issues.push({
        rule: "missing-collection-pages",
        severity: "error",
        message: `Detected collection "${collection.title}" is not represented by grouped pages.`,
      });
      continue;
    }

    for (const item of collection.items) {
      const child = collectionTargets.find((target) =>
        target.page.collectionId === collection.id &&
        (
          target.page.collectionItemId === item.id ||
          normalizeComparable(target.page.id).endsWith(normalizeComparable(item.slug)) ||
          normalizeComparable(target.page.title) === normalizeComparable(item.title)
        )
      );

      if (!child) {
        context.issues.push({
          rule: "missing-collection-item-page",
          severity: "error",
          message: `Collection "${collection.title}" is missing a grouped page for "${item.title}".`,
        });
        continue;
      }

      const childRoute = routeFromTargetPath(child.path);
      if (context.ignoredMissingRoutes.has(childRoute)) continue;
      if (!context.routeSet.has(childRoute)) {
        if (context.requireAllStructureRoutes) {
          context.issues.push({
            rule: "missing-collection-item-route",
            severity: "error",
            title: child.page.title,
            route: childRoute,
            message: `Collection item "${item.title}" did not generate route ${childRoute}.`,
          });
          continue;
        }
      }

      const childPage = context.pageByRoute.get(childRoute);
      if (childPage) validateCollectionItemDepth(context, childPage, childRoute, item.title, item.packageName, item.installCommand);
    }
  }
}

function validateCollectionItemDepth(
  context: CollectionCoverageContext,
  page: GeneratedPageContent,
  route: string,
  itemTitle: string,
  packageName?: string,
  installCommand?: string,
): void {
  const body = stripAllFrontmatter(page.content);
  if (body.trim().length < 600) {
    context.issues.push({
      rule: "thin-collection-item-page",
      severity: "error",
      title: page.title,
      route,
      message: `Collection item page "${itemTitle}" is too thin to be a complete guide.`,
    });
  }

  const expectedInstall = installCommand || (packageName ? `npm install ${packageName}` : undefined);
  if (expectedInstall && !body.includes(packageName ?? expectedInstall) && !body.includes(expectedInstall)) {
    context.issues.push({
      rule: "collection-item-missing-install",
      severity: "error",
      title: page.title,
      route,
      message: `Collection item page "${itemTitle}" omits its install package or command.`,
      excerpt: expectedInstall,
    });
  }
}

export function formatDocsQualityIssues(report: DocsQualityReport): string {
  return report.issues
    .map((issue) => {
      const where = [issue.title, issue.route, issue.line ? `line ${issue.line}` : undefined]
        .filter(Boolean)
        .join(" ");
      return `${issue.rule}${where ? ` (${where})` : ""}: ${issue.message}`;
    })
    .join("; ");
}

function routeFromGeneratedPath(pagePath: string, outputDir: string): string {
  const rel = relative(outputDir, pagePath).replace(/\\/g, "/");
  return routeFromIndexOutputPath(routeFromOutputPath(rel));
}

function buildGeneratedRouteSet(pages: GeneratedPageContent[], outputDir: string): Set<string> {
  return new Set(pages.map((page) => routeFromGeneratedPath(page.path, outputDir)));
}

function buildGeneratedPageMap(pages: GeneratedPageContent[], outputDir: string): Map<string, GeneratedPageContent> {
  return new Map(pages.map((page) => [routeFromGeneratedPath(page.path, outputDir), page]));
}

function buildExpectedRouteSet(structure: DocumentationStructure): Set<string> {
  return new Set(flattenStructure(structure).map((target) => routeFromTargetPath(target.path)));
}

function buildRestEndpointRouteSet(
  structure: DocumentationStructure,
): Set<string> {
  return new Set(
    flattenStructure(structure)
      .filter((target) => {
        const reference = target.page.reference;
        return reference?.kind === "rest" && Boolean(reference.endpointId);
      })
      .map((target) => routeFromTargetPath(target.path)),
  );
}

function extractInternalLinks(content: string): string[] {
  const links = new Set<string>();
  const markdownLink = /\]\((\/[^)#\s]+)(?:#[^)]+)?\)/g;
  const hrefLink = /href=["'](\/[^"'#]+)(?:#[^"']+)?["']/g;
  const expressionHrefLink = /href=\{\s*["'](\/[^"'#]+)(?:#[^"']+)?["']\s*\}/g;
  for (const regex of [markdownLink, hrefLink, expressionHrefLink]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      links.add(normalizeRoute(match[1].split(/[?#]/)[0] ?? match[1]));
    }
  }
  return Array.from(links);
}

const LINK_DESTINATION_PATTERNS = [
  /\]\(\s*(?:<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g,
  /\bhref\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|\{\s*(?:"[^"\n]*"|'[^'\n]*')\s*\})/g,
  /^\s*\[[^\]\n]+\]:\s*\S+.*$/gm,
  /<https?:\/\/[^>\n]+>/g,
  /https?:\/\/[^\s<>"']+/g,
] as const;

function maskRouteDestinations(content: string, routeRegistry: RouteRegistry): string {
  let masked = content;
  for (const pattern of LINK_DESTINATION_PATTERNS) {
    masked = masked.replace(pattern, maskText);
  }

  const routes = new Set([
    ...routeRegistry.routeSet,
    ...routeRegistry.aliasToRoute.keys(),
  ]);
  for (const route of Array.from(routes).sort((left, right) => right.length - left.length)) {
    masked = maskExactRoute(masked, route);
  }
  return masked;
}

function maskExactRoute(content: string, route: string): string {
  if (route === "/") return content;

  let masked = content;
  let searchFrom = 0;
  while (searchFrom < masked.length) {
    const start = masked.indexOf(route, searchFrom);
    if (start < 0) break;

    const trailingCharacter = masked[start + route.length];
    if (
      trailingCharacter === undefined ||
      /[\s"'`)<>,.!?:;#?}\]]/.test(trailingCharacter)
    ) {
      masked = `${masked.slice(0, start)}${maskText(route)}${masked.slice(start + route.length)}`;
    }
    searchFrom = start + route.length;
  }
  return masked;
}

function maskText(value: string): string {
  return value.replace(/[^\n]/g, " ");
}

function routeFromTargetPath(path: string): string {
  return routeFromOutputPath(path);
}

function routeFromIndexOutputPath(route: string): string {
  if (route === "/index") return "/";
  if (!route.endsWith("/index")) return route;
  return normalizeRoute(route.slice(0, -"/index".length) || "/");
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function inferPageAudience(
  title: string,
  route: string,
  defaultAudience: "consumer" | "maintainer" | "mixed",
): "consumer" | "maintainer" | "reference" {
  if (route.includes("/development/") || route.startsWith("/development")) return "maintainer";
  if (/\b(contributing|development|architecture|e2e|internal)\b/i.test(title)) return "maintainer";
  if (defaultAudience === "maintainer") return "maintainer";
  return "consumer";
}

function findLineMatch(
  content: string,
  regex: RegExp,
  excerptSource = content,
): { line: number; excerpt: string } | null {
  const lines = content.split("\n");
  const excerptLines = excerptSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      return {
        line: i + 1,
        excerpt: (excerptLines[i] ?? lines[i]).trim().slice(0, 240),
      };
    }
  }
  return null;
}
