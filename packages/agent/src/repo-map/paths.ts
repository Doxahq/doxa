/**
 * Path rules for the repo map. The project listing already drops `.git`,
 * `node_modules`, `dist`, and build output (`listProjectFiles`); these rules
 * add the files a planner should not see as product code.
 */

/** Vendored and generated code: not parsed at all. */
const SKIPPED_SEGMENTS = new Set(["vendor", "third_party", "third-party", "__pycache__", ".venv", "venv", "target"]);
const SKIPPED_FILE = /(?:\.min\.[cm]?js|\.generated\.\w+|\.pb\.go|_pb2(?:_grpc)?\.py|\.bundle\.js)$/;

/** Tests and fixtures: parsed for references, never shown. */
const HIDDEN_SEGMENTS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "__mocks__", "fixtures", "__fixtures__", "testdata", "e2e",
]);
const HIDDEN_FILE = /(?:\.(?:test|spec|stories|bench)\.[cm]?[jt]sx?|_test\.go|(?:^|\/)test_[^/]*\.py|_test\.py|(?:^|\/)conftest\.py)$/;

export type ManifestFormat = "package-json" | "cargo" | "pyproject" | "go-mod" | "none";

/** Files that mark a package root, with the format used to read its name. */
const MANIFEST_FORMATS: ReadonlyMap<string, ManifestFormat> = new Map([
  ["package.json", "package-json"],
  ["Cargo.toml", "cargo"],
  ["pyproject.toml", "pyproject"],
  ["go.mod", "go-mod"],
  ["setup.py", "none"],
  ["composer.json", "package-json"],
  ["pom.xml", "none"],
  ["build.gradle", "none"],
  ["build.gradle.kts", "none"],
  ["Gemfile", "none"],
  ["mix.exs", "none"],
  ["pubspec.yaml", "none"],
  ["Package.swift", "none"],
]);

function segments(path: string): string[] {
  return path.split("/");
}

/** Vendored, generated, and tool folders (`.github`, `.claude`, ...) are not product code. */
export function isSkippedPath(path: string): boolean {
  return segments(path)
    .slice(0, -1)
    .some((segment) => SKIPPED_SEGMENTS.has(segment) || segment.startsWith(".")) || SKIPPED_FILE.test(path);
}

export function isHiddenPath(path: string): boolean {
  return segments(path).slice(0, -1).some((segment) => HIDDEN_SEGMENTS.has(segment)) || HIDDEN_FILE.test(path);
}

export function manifestFormat(path: string): ManifestFormat | null {
  return MANIFEST_FORMATS.get(basename(path)) ?? null;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Joins and normalizes `a/b` with `../c`; returns null when it leaves the root. */
export function joinPath(base: string, relative: string): string | null {
  const parts = base === "." ? [] : base.split("/");
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

/** True when `path` is `directory` or inside it. */
export function isWithin(path: string, directory: string): boolean {
  return directory === "." || path === directory || path.startsWith(`${directory}/`);
}
