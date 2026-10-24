import { MDX_FORMAT_OPTIONS } from "@doxahq/mdx-runtime/format";
import type { BlockContent, ListItem, PhrasingContent, Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { SecretRedactor } from "./secrets";

/**
 * C0 and C1 controls except tab and newline, zero-width characters,
 * bidirectional embeddings and isolates, and the BOM: characters that can
 * hide text or change how a reader sees it.
 */
const HIDDEN_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** CommonMark only: no MDX, so JSX, `{expressions}` and `import` lines are plain text. */
const markdown = unified().use(remarkParse).use(remarkStringify, MDX_FORMAT_OPTIONS);

const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "mailto:"]);
const CODE_LANGUAGE = /^[\w+#-]{1,20}$/;

/**
 * Spec Markdown, made safe to show. The text is parsed as CommonMark and
 * printed again from an allowlist of node types, so every code fence and
 * list is closed. Headings become bold paragraphs, so they cannot change
 * the page outline. Raw HTML becomes text, images become their alt text,
 * and a link keeps its target only for `https:`, `http:`, `mailto:` and
 * `#anchor`. Hidden characters and known secrets are removed. The page
 * template escapes the result again before MDX sees it.
 */
export function sanitizeSpecMarkdown(
  text: string | undefined,
  maxChars: number,
  redactor: SecretRedactor,
): string | undefined {
  if (!text) return undefined;
  // Redaction runs on the source text: printing escapes characters such as `_`.
  const cleaned = cutText(redactor.redact(removeHiddenCharacters(text)), maxChars);
  const tree = markdown.parse(cleaned);
  const safeTree: Root = { type: "root", children: sanitizeFlow(tree.children) };
  const printed = markdown.stringify(safeTree).trim();
  if (!printed) return undefined;
  // Escapes can make the printed text longer; plain text is the fallback then.
  return printed.length <= maxChars ? printed : sanitizeSpecPlainText(text, maxChars, redactor);
}

/**
 * Spec text that must stay one plain line, such as a title: NFC, no hidden
 * characters, no newlines, known secrets removed and cut to `maxChars`.
 */
export function sanitizeSpecPlainText(
  text: string | undefined,
  maxChars: number,
  redactor: SecretRedactor,
): string | undefined {
  if (!text) return undefined;
  const line = redactor.redact(removeHiddenCharacters(text).replace(/\s+/g, " ").trim());
  return line ? cutText(line, maxChars) : undefined;
}

export function removeHiddenCharacters(text: string): string {
  return text.normalize("NFC").replace(HIDDEN_CHARACTERS, "");
}

function sanitizeFlow(nodes: readonly RootContent[]): BlockContent[] {
  return nodes.flatMap((node): BlockContent[] => {
    switch (node.type) {
      case "paragraph":
        return paragraph(sanitizePhrasing(node.children));
      case "heading":
        return paragraph([{ type: "strong", children: sanitizePhrasing(node.children) }]);
      case "blockquote":
        return [{ type: "blockquote", children: sanitizeFlow(node.children) }];
      case "list":
        return [{
          type: "list",
          ordered: node.ordered,
          start: node.start,
          spread: false,
          children: node.children.map((item): ListItem => ({
            type: "listItem",
            spread: false,
            children: sanitizeFlow(item.children),
          })),
        }];
      case "code":
        return [{
          type: "code",
          lang: node.lang && CODE_LANGUAGE.test(node.lang) ? node.lang : null,
          value: node.value,
        }];
      case "thematicBreak":
        return [{ type: "thematicBreak" }];
      case "html":
        return paragraph(textOf(stripTags(node.value)));
      default:
        return [];
    }
  });
}

function sanitizePhrasing(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  return nodes.flatMap((node): PhrasingContent[] => {
    switch (node.type) {
      case "text":
        return textOf(node.value);
      case "emphasis":
      case "strong":
      case "delete":
        return [{ type: node.type, children: sanitizePhrasing(node.children) }];
      case "inlineCode":
        return [{ type: "inlineCode", value: node.value }];
      case "break":
        return [{ type: "break" }];
      case "link":
        return isSafeLink(node.url)
          ? [{ type: "link", url: node.url.trim(), children: sanitizePhrasing(node.children) }]
          : sanitizePhrasing(node.children);
      case "linkReference":
        return sanitizePhrasing(node.children);
      case "image":
      case "imageReference":
        return textOf(node.alt ?? "");
      case "html":
        return /^<br\s*\/?>$/i.test(node.value.trim()) ? [{ type: "break" }] : textOf(stripTags(node.value));
      default:
        return [];
    }
  });
}

function paragraph(children: PhrasingContent[]): BlockContent[] {
  return children.length > 0 ? [{ type: "paragraph", children }] : [];
}

function textOf(value: string): PhrasingContent[] {
  return value ? [{ type: "text", value }] : [];
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function isSafeLink(url: string): boolean {
  const target = url.trim();
  if (target.startsWith("#")) return /^#[\w.~-]*$/.test(target);
  try {
    const parsed = new URL(target);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function cutText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Twice the limit in code units holds at least the limit in code points.
  return `${Array.from(text.slice(0, maxChars * 2)).slice(0, maxChars - 1).join("").trimEnd()}…`;
}
