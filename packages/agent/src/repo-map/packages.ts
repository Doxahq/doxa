/**
 * Package roots: directories with a manifest (package.json, Cargo.toml,
 * pyproject.toml, go.mod, ...). They bound monorepo areas and map package
 * names (`@scope/pkg`, crate names, Go module paths) to directories for
 * import resolution.
 */

import { compareStrings } from "./collections";
import { dirname, manifestFormat, type ManifestFormat } from "./paths";

export interface PackageRoot {
  /** Directory of the manifest ("." for the repository root). */
  path: string;
  /** npm/composer name, crate name, or Python project name. */
  name?: string;
  /** Go module path from `go.mod`. */
  goModule?: string;
}

export interface ManifestInput {
  path: string;
  content: string;
}

export function isManifestPath(path: string): boolean {
  return manifestFormat(path) !== null;
}

/** One root per directory; names come from the first manifest that has one. */
export function readPackageRoots(manifests: readonly ManifestInput[]): PackageRoot[] {
  const roots = new Map<string, PackageRoot>();
  const sorted = [...manifests].sort((a, b) => compareStrings(a.path, b.path));
  for (const manifest of sorted) {
    const format = manifestFormat(manifest.path);
    if (!format) continue;
    const directory = dirname(manifest.path);
    const root = roots.get(directory) ?? { path: directory };
    const parsed = parseManifest(format, manifest.content);
    if (parsed.name && !root.name) root.name = parsed.name;
    if (parsed.goModule) root.goModule = parsed.goModule;
    roots.set(directory, root);
  }
  return [...roots.values()].sort((a, b) => compareStrings(a.path, b.path));
}

interface ParsedManifest {
  name?: string;
  goModule?: string;
}

function parseManifest(format: ManifestFormat, content: string): ParsedManifest {
  switch (format) {
    case "package-json":
      return { name: jsonName(content) };
    case "cargo":
      return { name: tomlTableString(content, "package", "name") };
    case "pyproject":
      return {
        name: tomlTableString(content, "project", "name") ?? tomlTableString(content, "tool.poetry", "name"),
      };
    case "go-mod":
      return { goModule: /^module\s+(\S+)/m.exec(content)?.[1] };
    case "none":
      return {};
  }
}

function jsonName(content: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string") {
      return parsed.name;
    }
  } catch {
    // An invalid manifest still marks a package root; it has no name.
  }
  return undefined;
}

/** Reads `key = "value"` from a `[table]` section of a small TOML file. */
function tomlTableString(content: string, table: string, key: string): string | undefined {
  let inTable = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      inTable = header[1].trim() === table;
      continue;
    }
    if (!inTable) continue;
    const entry = new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`).exec(line);
    if (entry) return entry[1];
  }
  return undefined;
}
