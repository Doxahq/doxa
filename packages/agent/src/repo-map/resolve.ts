/**
 * Resolves import specifiers to project files. Specifiers that do not land
 * on a project file (third-party packages, the standard library) resolve to
 * nothing: the map ranks the project's own code.
 */

import { appendToGroup, compareStrings } from "./collections";
import type { PackageRoot } from "./packages";
import { basename, dirname, isHiddenPath, isWithin, joinPath } from "./paths";
import type { RepoImport, RepoMapLanguage } from "./types";

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** TypeScript ESM imports name the emitted `.js` file of a `.ts` source. */
const JS_EMITTED_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
/** Path aliases most TypeScript projects map to their source root. */
const JS_SOURCE_ALIASES = ["~/", "@/", "#/"];
const JS_ENTRY_CANDIDATES = ["src/index", "index", "src/main", "lib/index", "mod"];

export type ImportResolver = (from: string, language: RepoMapLanguage, entry: RepoImport) => string[];

export function createImportResolver(
  sourceFiles: readonly string[],
  packages: readonly PackageRoot[],
): ImportResolver {
  const files = new Set(sourceFiles);
  const index = new ProjectIndex(sourceFiles, packages);

  const firstExisting = (candidates: Iterable<string | null>): string[] => {
    for (const candidate of candidates) {
      if (candidate && files.has(candidate)) return [candidate];
    }
    return [];
  };

  const resolvers: Readonly<Record<RepoMapLanguage, (from: string, entry: RepoImport) => string[]>> = {
    typescript: (from, entry) => resolveJavaScript(from, entry.specifier, index, firstExisting),
    javascript: (from, entry) => resolveJavaScript(from, entry.specifier, index, firstExisting),
    python: (from, entry) => resolvePython(from, entry, index, firstExisting),
    go: (_from, entry) => index.goPackageFiles(entry.specifier),
    rust: (from, entry) => resolveRust(from, entry, index, firstExisting),
    generic: (from, entry) => resolveGeneric(from, entry.specifier, index, firstExisting),
  };

  return (from, language, entry) => resolvers[language](from, entry).filter((target) => target !== from);
}

type FirstExisting = (candidates: Iterable<string | null>) => string[];

class ProjectIndex {
  private readonly packagesByDepth: PackageRoot[];
  private readonly packagesByName = new Map<string, PackageRoot>();
  private readonly goFilesByDirectory = new Map<string, string[]>();
  private readonly pythonModules = new Map<string, string[]>();
  private readonly pythonSourceRoots: Set<string>;

  constructor(sourceFiles: readonly string[], packages: readonly PackageRoot[]) {
    this.pythonSourceRoots = new Set(["", "src", "lib"]);
    for (const root of packages) {
      if (root.path === ".") continue;
      this.pythonSourceRoots.add(root.path);
      this.pythonSourceRoots.add(`${root.path}/src`);
    }
    this.packagesByDepth = [...packages].sort((a, b) => b.path.length - a.path.length || compareStrings(a.path, b.path));
    for (const root of packages) {
      if (root.name) {
        this.packagesByName.set(root.name, root);
        this.packagesByName.set(root.name.replace(/-/g, "_"), root);
      }
    }
    for (const file of [...sourceFiles].sort(compareStrings)) {
      if (file.endsWith(".go") && !isHiddenPath(file)) {
        const directory = dirname(file);
        appendToGroup(this.goFilesByDirectory, directory, file);
      }
      if (file.endsWith(".py")) this.indexPythonModule(file);
    }
    for (const candidates of this.pythonModules.values()) {
      candidates.sort((a, b) => a.length - b.length || compareStrings(a, b));
    }
  }

  /** The deepest package root that contains `path`. */
  packageOf(path: string): PackageRoot | undefined {
    return this.packagesByDepth.find((root) => isWithin(path, root.path));
  }

  /** The workspace package a bare specifier names, with the rest of the path. */
  packageForSpecifier(specifier: string): { root: PackageRoot; subpath: string } | undefined {
    const parts = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const name = parts.slice(0, nameLength).join("/");
    const root = this.packagesByName.get(name);
    return root ? { root, subpath: parts.slice(nameLength).join("/") } : undefined;
  }

  crateRoot(name: string): PackageRoot | undefined {
    return this.packagesByName.get(name);
  }

  goPackageFiles(importPath: string): string[] {
    for (const root of this.packagesByDepth) {
      if (!root.goModule) continue;
      if (importPath !== root.goModule && !importPath.startsWith(`${root.goModule}/`)) continue;
      const relative = importPath.slice(root.goModule.length + 1);
      const directory = relative ? joinPath(root.path, relative) : root.path;
      return directory ? this.goFilesByDirectory.get(directory) ?? [] : [];
    }
    return [];
  }

  /** Files for a dotted module, shortest path first. */
  pythonModule(dotted: string): string[] {
    return this.pythonModules.get(dotted) ?? [];
  }

  /**
   * Indexes `src/app/models.py` as `app.models` and `services/api/app/x.py`
   * as `app.x` when `services/api` is a package: a dotted name starts at the
   * root, `src/`, `lib/`, or a package root, like on `sys.path`.
   */
  private indexPythonModule(file: string): void {
    const withoutExtension = file.slice(0, -".py".length);
    const modulePath = basename(withoutExtension) === "__init__" ? dirname(withoutExtension) : withoutExtension;
    if (modulePath === ".") return;
    const parts = modulePath.split("/");
    for (let start = 0; start < parts.length; start++) {
      if (!this.pythonSourceRoots.has(parts.slice(0, start).join("/"))) continue;
      const key = parts.slice(start).join(".");
      appendToGroup(this.pythonModules, key, file);
    }
  }
}

function* withJavaScriptExtensions(base: string | null): Generator<string | null> {
  if (!base) return;
  yield base;
  const extension = /\.[cm]?jsx?$/.exec(base)?.[0];
  if (extension) {
    const stem = base.slice(0, -extension.length);
    for (const replacement of JS_EMITTED_EXTENSIONS[extension] ?? []) yield `${stem}${replacement}`;
  }
  for (const candidate of JS_EXTENSIONS) yield `${base}${candidate}`;
  for (const candidate of JS_EXTENSIONS) yield `${base}/index${candidate}`;
}

function resolveJavaScript(
  from: string,
  specifier: string,
  index: ProjectIndex,
  firstExisting: FirstExisting,
): string[] {
  if (specifier.startsWith(".")) {
    return firstExisting(withJavaScriptExtensions(joinPath(dirname(from), specifier)));
  }
  const alias = JS_SOURCE_ALIASES.find((prefix) => specifier.startsWith(prefix));
  if (alias) {
    const root = index.packageOf(from)?.path ?? ".";
    const rest = specifier.slice(alias.length);
    return firstExisting([
      ...withJavaScriptExtensions(joinPath(root, `src/${rest}`)),
      ...withJavaScriptExtensions(joinPath(root, rest)),
    ]);
  }
  const target = index.packageForSpecifier(specifier);
  if (!target) return [];
  const candidates = target.subpath
    ? [`src/${target.subpath}`, target.subpath]
    : JS_ENTRY_CANDIDATES;
  return firstExisting(candidates.flatMap((candidate) => [
    ...withJavaScriptExtensions(joinPath(target.root.path, candidate)),
  ]));
}

function resolvePython(
  from: string,
  entry: RepoImport,
  index: ProjectIndex,
  firstExisting: FirstExisting,
): string[] {
  const dots = /^\.*/.exec(entry.specifier)?.[0].length ?? 0;
  const module = entry.specifier.slice(dots);
  const names = entry.names ?? [];

  if (dots > 0) {
    let base: string | null = dirname(from);
    for (let level = 1; level < dots && base; level++) base = base === "." ? null : dirname(base);
    if (!base) return [];
    const modulePath = module ? joinPath(base, module.replace(/\./g, "/")) : base;
    if (!modulePath) return [];
    const submodules = names.flatMap((name) => firstExisting(pythonFileCandidates(joinPath(modulePath, name))));
    return submodules.length > 0 ? submodules : firstExisting(pythonFileCandidates(modulePath));
  }

  const submodules = names.flatMap((name) => index.pythonModule(`${module}.${name}`).slice(0, 1));
  return submodules.length > 0 ? submodules : index.pythonModule(module).slice(0, 1);
}

function pythonFileCandidates(modulePath: string | null): Array<string | null> {
  if (!modulePath || modulePath === ".") return [];
  return [`${modulePath}.py`, `${modulePath}/__init__.py`];
}

function resolveRust(
  from: string,
  entry: RepoImport,
  index: ProjectIndex,
  firstExisting: FirstExisting,
): string[] {
  if (entry.kind === "module-declaration") {
    const directory = rustModuleDirectory(from);
    return firstExisting([joinPath(directory, `${entry.specifier}.rs`), joinPath(directory, `${entry.specifier}/mod.rs`)]);
  }
  const [head, ...rest] = entry.specifier.split("::").filter((part) => part !== "*");
  if (!head) return [];
  let sourceRoot: string | null;
  if (head === "crate") {
    sourceRoot = joinPath(index.packageOf(from)?.path ?? ".", "src");
  } else if (head === "self" || head === "super") {
    sourceRoot = head === "self" ? rustModuleDirectory(from) : dirname(rustModuleDirectory(from));
  } else {
    const crate = index.crateRoot(head);
    if (!crate) return [];
    sourceRoot = joinPath(crate.path, "src");
    if (rest.length === 0) return firstExisting([joinPath(sourceRoot ?? ".", "lib.rs")]);
  }
  if (!sourceRoot) return [];
  // `crate::a::b::Item` names a module path then an item; try the longest module first.
  for (let length = rest.length; length > 0; length--) {
    const modulePath = joinPath(sourceRoot, rest.slice(0, length).join("/"));
    const found = firstExisting([modulePath && `${modulePath}.rs`, modulePath && `${modulePath}/mod.rs`]);
    if (found.length > 0) return found;
  }
  return [];
}

/** Where `mod child;` files live: beside `lib.rs`/`main.rs`/`mod.rs`, else in a folder named after the file. */
function rustModuleDirectory(file: string): string {
  const name = basename(file);
  if (name === "lib.rs" || name === "main.rs" || name === "mod.rs") return dirname(file);
  return joinPath(dirname(file), name.slice(0, -".rs".length)) ?? dirname(file);
}

function resolveGeneric(
  from: string,
  specifier: string,
  index: ProjectIndex,
  firstExisting: FirstExisting,
): string[] {
  if (specifier.startsWith("./")) {
    return firstExisting([joinPath(dirname(from), specifier)]);
  }
  // Java-style `com.acme.Type` names `.../com/acme/Type.<ext>` under some source root.
  const extension = /\.\w+$/.exec(from)?.[0];
  if (!extension || !specifier.includes(".")) return [];
  const suffix = `${specifier.replace(/\./g, "/")}${extension}`;
  const root = index.packageOf(from)?.path ?? ".";
  return firstExisting([
    joinPath(root, suffix),
    joinPath(root, `src/main/java/${suffix}`),
    joinPath(root, `src/main/kotlin/${suffix}`),
    joinPath(root, `src/${suffix}`),
  ]);
}
