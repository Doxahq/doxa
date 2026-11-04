import type { RuntimeMdxNode, RuntimeMdxTextNode } from "@doxahq/mdx-runtime";

import { nodeText, type EndpointCodeSample } from "@/src/lib/endpoint-document";

/**
 * Characters that need no quoting in a shell or in a string of any sample
 * language. Readers paste samples, so a base URL with others stays out of them.
 */
const SAMPLE_SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/%]+$/;

/** The owner's base URL for display, or null when it has no host of its own. */
export function readApiBaseUrl(baseUrl: string | undefined): string | null {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed && SAMPLE_SAFE_URL.test(trimmed) && URL.canParse(trimmed) ? trimmed : null;
}

/** Any URL in a sample. It does not use page content, so its cost stays linear. */
const SAMPLE_URL = /https?:\/\/[^\s'"`<>]+/;
const PATH_PARAMETER = /\{[^{}]*\}/;

function indexOrEnd(text: string, pattern: RegExp): number {
  const found = text.search(pattern);
  return found === -1 ? text.length : found;
}

/** True when `value` fits a path segment, with each `{name}` as any text. */
function segmentMatches(segment: string, value: string): boolean {
  const [first = "", ...others] = segment.split(PATH_PARAMETER);
  if (others.length === 0) return segment === value;
  const last = others.pop() ?? "";
  if (!value.startsWith(first) || !value.endsWith(last)) return false;

  const limit = value.length - last.length;
  let position = first.length;
  for (const literal of others) {
    const found = value.indexOf(literal, position);
    if (found === -1) return false;
    position = found + literal.length;
  }
  return position <= limit;
}

/**
 * Where the page path starts in the path of a URL, or null when the URL does
 * not end with the page path. The part before it is the generated base path.
 */
function findPagePathStart(urlPath: string, pagePath: string): number | null {
  let start = urlPath.length;
  while (start > 0 && urlPath[start - 1] === "/") start -= 1;

  for (const segment of pagePath.split("/").filter(Boolean).reverse()) {
    if (start === 0) return null;
    const slash = urlPath.lastIndexOf("/", start - 1);
    if (slash === -1 || !segmentMatches(segment, urlPath.slice(slash + 1, start))) {
      return null;
    }
    start = slash;
  }
  return start;
}

/**
 * The range of the base URL in the sample. Each sample generator names the
 * request URL first, so only the first URL counts. A URL in the request body
 * can never change, and a sample with another first URL stays as it is.
 */
function findBaseUrlRange(text: string, pagePath: string): { start: number; end: number } | null {
  const match = SAMPLE_URL.exec(text);
  if (!match) return null;
  const url = match[0];
  const authorityStart = url.indexOf("://") + 3;
  const pathStart = authorityStart + indexOrEnd(url.slice(authorityStart), /[/?#]/);
  const pathEnd = pathStart + indexOrEnd(url.slice(pathStart), /[?#]/);
  const urlPath = url.slice(pathStart, pathEnd);

  const pagePathStart = findPagePathStart(urlPath, pagePath);
  if (pagePathStart === null) return null;
  return { start: match.index, end: match.index + pathStart + pagePathStart };
}

function collectTextNodes(nodes: RuntimeMdxNode[], found: RuntimeMdxTextNode[] = []) {
  for (const node of nodes) {
    if (node.type === "text") found.push(node);
    else collectTextNodes(node.children ?? [], found);
  }
  return found;
}

/** Highlighting can split a URL over tokens, so the range can cover many nodes. */
function replaceTextRange(
  nodes: RuntimeMdxNode[],
  range: { start: number; end: number },
  replacement: string,
): void {
  let offset = 0;
  let placed = false;
  for (const node of collectTextNodes(nodes)) {
    const nodeStart = offset;
    offset += node.value.length;
    if (offset <= range.start || nodeStart >= range.end) continue;
    const head = node.value.slice(0, Math.max(0, range.start - nodeStart));
    const tail = node.value.slice(Math.max(0, range.end - nodeStart));
    node.value = `${head}${placed ? "" : replacement}${tail}`;
    placed = true;
  }
}

/**
 * The sample with the owner's base URL in place of the one from generation, so
 * the page shows the host that the playground uses. Published artifacts hold
 * the old URL, so this runs when the page renders.
 */
export function withApiBaseUrl(
  sample: EndpointCodeSample,
  path: string,
  baseUrl: string | null,
): EndpointCodeSample {
  if (!baseUrl) return sample;
  const range = findBaseUrlRange(nodeText(sample.node), path);
  if (!range) return sample;
  const node = structuredClone(sample.node);
  replaceTextRange([node], range, baseUrl);
  return { ...sample, node, text: nodeText(node).trim() };
}
