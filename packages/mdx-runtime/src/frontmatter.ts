import type { RuntimeMdxFrontmatter } from "./types";

export interface RuntimeMdxSource {
  content: string;
  frontmatter: RuntimeMdxFrontmatter;
}

export function readFrontmatter(source: string): RuntimeMdxSource {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { content: source, frontmatter: {} };
  }

  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  const closingMarker = `${newline}---${newline}`;
  const closingIndex = source.indexOf(closingMarker, 3);
  if (closingIndex === -1) {
    return { content: source, frontmatter: {} };
  }

  const rawFrontmatter = source.slice(3 + newline.length, closingIndex);
  const content = source.slice(closingIndex + closingMarker.length);
  return {
    content,
    frontmatter: parseFrontmatterYaml(rawFrontmatter),
  };
}

function parseFrontmatterYaml(yaml: string): RuntimeMdxFrontmatter {
  const data: RuntimeMdxFrontmatter = {};
  const lines = yaml.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (key === "title") {
      data.title = readYamlString(rawValue);
      continue;
    }

    if (key === "description") {
      data.description = readYamlString(rawValue);
      continue;
    }

    if (key === "keywords") {
      data.keywords = readYamlStringList(rawValue, lines, index);
      if (!rawValue.trim()) {
        index = skipYamlList(lines, index);
      }
      continue;
    }

    if (key === "apiMethod") {
      data.apiMethod = readApiMethod(rawValue);
      continue;
    }

    if (key === "apiPath") {
      data.apiPath = readYamlString(rawValue);
    }
  }

  return {
    title: data.title,
    description: data.description,
    keywords: data.keywords?.length ? data.keywords : undefined,
    apiMethod: data.apiMethod,
    apiPath: data.apiPath,
  };
}

function readApiMethod(
  value: string,
): RuntimeMdxFrontmatter["apiMethod"] {
  switch (readYamlString(value)?.toUpperCase()) {
    case "GET": return "GET";
    case "POST": return "POST";
    case "PUT": return "PUT";
    case "PATCH": return "PATCH";
    case "DELETE": return "DELETE";
    case "HEAD": return "HEAD";
    case "OPTIONS": return "OPTIONS";
    default: return undefined;
  }
}

function readYamlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = /^["'](.*)["']$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

function readYamlStringList(
  value: string,
  lines: string[],
  keyIndex: number,
): string[] | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => readYamlString(item))
      .filter((item): item is string => Boolean(item));
  }

  if (trimmed) {
    const item = readYamlString(trimmed);
    return item ? [item] : undefined;
  }

  const items: string[] = [];
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const match = /^\s*-\s+(.+)$/.exec(lines[index] ?? "");
    if (!match) break;
    const item = readYamlString(match[1]);
    if (item) items.push(item);
  }
  return items;
}

function skipYamlList(lines: string[], keyIndex: number): number {
  let index = keyIndex;
  while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1] ?? "")) {
    index += 1;
  }
  return index;
}
