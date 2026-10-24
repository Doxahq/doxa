import type {
  RuntimeMdxElementName,
  RuntimeMdxNode,
  RuntimeMdxPropValue,
} from "../types";

export interface HastTextNode {
  type: "text";
  value: string;
}

export interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Readonly<Record<string, unknown>>;
  children: readonly HastNode[];
}

export type HastNode = HastElementNode | HastTextNode;

export function isHastNode(value: unknown): value is HastNode {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.value === "string";
  if (value.type !== "element" || typeof value.tagName !== "string") {
    return false;
  }
  if (value.properties !== undefined && !isRecord(value.properties)) {
    return false;
  }
  return Array.isArray(value.children) && value.children.every(isHastNode);
}

export function hastToRuntimeMdx(node: HastNode): RuntimeMdxNode {
  if (node.type === "text") {
    return { type: "text", value: node.value };
  }

  const props = convertProperties(node.properties);
  const children = node.children.map(hastToRuntimeMdx);

  return {
    type: "element",
    name: toRuntimeElementName(node.tagName),
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function convertProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, RuntimeMdxPropValue> {
  const result: Record<string, RuntimeMdxPropValue> = {};

  for (const [name, value] of Object.entries(properties ?? {})) {
    if (name === "class" || name === "className") {
      const className = normalizeClassName(value);
      if (className) result.className = className;
      continue;
    }

    if (name === "style" && typeof value === "string") {
      result.style = parseStyle(value);
      continue;
    }

    const normalizedValue = normalizePropertyValue(value);
    if (normalizedValue !== null) {
      result[toReactPropertyName(name)] = normalizedValue;
    }
  }

  return result;
}

function normalizeClassName(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function normalizePropertyValue(value: unknown): RuntimeMdxPropValue | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter(
        (part): part is string | number =>
          typeof part === "string" || typeof part === "number",
      )
      .join(" ");
  }
  return null;
}

function parseStyle(style: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const declaration of style.split(";")) {
    const separatorIndex = declaration.indexOf(":");
    if (separatorIndex < 0) continue;

    const property = declaration.slice(0, separatorIndex).trim();
    const value = declaration.slice(separatorIndex + 1).trim();
    if (!property || !value) continue;

    result[toReactStyleName(property)] = value;
  }

  return result;
}

function toReactStyleName(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function toReactPropertyName(property: string): string {
  return property === "tabindex" ? "tabIndex" : property;
}

function toRuntimeElementName(tagName: string): RuntimeMdxElementName {
  switch (tagName) {
    case "pre":
    case "code":
    case "span":
      return tagName;
    default:
      throw new Error(`Unsupported highlighted element: ${tagName}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
