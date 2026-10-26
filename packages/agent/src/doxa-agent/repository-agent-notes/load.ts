import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { cleanInstructionText } from "@doxahq/contracts";
import { resolveProjectPath } from "../../core/tools/project-path";

/**
 * Loads the notes that a repository keeps for coding agents (AGENTS.md,
 * CLAUDE.md and the like) so the analysis reads them first. They are facts
 * about the repository, never instructions to Doxabot.
 *
 * A missing, unreadable, binary or oversized file is skipped; loading never
 * fails a run.
 */

/** Root files, in reading order. */
export const ROOT_AGENT_NOTE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
] as const;

export const AGENT_NOTE_LIMITS = {
  /** Characters kept from one file. */
  fileLength: 16 * 1024,
  /** Characters kept from all files together. */
  totalLength: 48 * 1024,
  /** Larger files are skipped without reading them. */
  fileBytes: 256 * 1024,
  /** Package-level AGENTS.md files read in a monorepo. */
  packageNotes: 10,
  cursorRules: 10,
} as const;

const CURSOR_RULES_DIRECTORY = ".cursor/rules";
const PACKAGE_NOTE_FILE = "AGENTS.md";
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor"]);
/** `@path` on a line of its own: a pointer to another notes file, as CLAUDE.md often uses. */
const POINTER_LINE = /^@(\S+)$/;

export interface RepositoryAgentNote {
  /** Repository-relative path with forward slashes. */
  path: string;
  text: string;
  truncated: boolean;
}

export type AgentNoteSkipReason = "too_large" | "not_text" | "unreadable" | "outside_repository" | "over_budget";

export interface RepositoryAgentNotes {
  notes: RepositoryAgentNote[];
  skipped: Array<{ path: string; reason: AgentNoteSkipReason }>;
}

export async function loadRepositoryAgentNotes(projectRoot: string): Promise<RepositoryAgentNotes> {
  const result: RepositoryAgentNotes = { notes: [], skipped: [] };
  const seen = new Set<string>();
  let remaining: number = AGENT_NOTE_LIMITS.totalLength;

  const addNote = async (path: string, followPointers: boolean): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);

    const read = await readNoteFile(projectRoot, path);
    if (read.kind === "absent") return;
    if (read.kind === "skipped") {
      result.skipped.push({ path, reason: read.reason });
      return;
    }
    if (remaining <= 0) {
      result.skipped.push({ path, reason: "over_budget" });
      return;
    }

    const limit = Math.min(AGENT_NOTE_LIMITS.fileLength, remaining);
    const truncated = read.text.length > limit;
    const text = truncated ? read.text.slice(0, limit) : read.text;
    remaining -= text.length;
    result.notes.push({ path, text, truncated });

    if (!followPointers) return;
    for (const target of pointerTargets(path, read.text)) {
      await addNote(target, false);
    }
  };

  const candidates = [
    ...ROOT_AGENT_NOTE_FILES,
    ...await listCursorRules(projectRoot),
    ...await listPackageNotes(projectRoot),
  ];
  for (const path of candidates) {
    await addNote(path, true);
  }

  return result;
}

type NoteFileRead =
  | { kind: "absent" }
  | { kind: "skipped"; reason: AgentNoteSkipReason }
  | { kind: "read"; text: string };

async function readNoteFile(projectRoot: string, path: string): Promise<NoteFileRead> {
  let fullPath: string;
  try {
    fullPath = await resolveProjectPath(projectRoot, path);
  } catch {
    return { kind: "skipped", reason: "outside_repository" };
  }

  try {
    const info = await stat(fullPath);
    if (!info.isFile()) return { kind: "absent" };
    if (info.size > AGENT_NOTE_LIMITS.fileBytes) return { kind: "skipped", reason: "too_large" };

    const bytes = await readFile(fullPath);
    const decoded = decodeUtf8(bytes);
    if (decoded === null) return { kind: "skipped", reason: "not_text" };

    const text = cleanInstructionText(decoded);
    return text ? { kind: "read", text } : { kind: "absent" };
  } catch (error) {
    return isMissingFile(error) ? { kind: "absent" } : { kind: "skipped", reason: "unreadable" };
  }
}

/** Files that a note points to with `@path` lines, relative to the note. Followed one level deep. */
function pointerTargets(path: string, text: string): string[] {
  const directory = posix.dirname(path);
  return text
    .split("\n")
    .map((line) => POINTER_LINE.exec(line.trim())?.[1])
    .filter((target): target is string => target !== undefined)
    .map((target) => posix.normalize(posix.join(directory, target)));
}

async function listCursorRules(projectRoot: string): Promise<string[]> {
  const names = await safeReaddir(join(projectRoot, CURSOR_RULES_DIRECTORY));
  return names
    .filter((name) => name.endsWith(".mdc"))
    .sort()
    .slice(0, AGENT_NOTE_LIMITS.cursorRules)
    .map((name) => `${CURSOR_RULES_DIRECTORY}/${name}`);
}

/** AGENTS.md files one and two levels down, such as `packages/api/AGENTS.md`. */
async function listPackageNotes(projectRoot: string): Promise<string[]> {
  const found: string[] = [];
  for (const top of await listDirectories(projectRoot, "")) {
    found.push(`${top}/${PACKAGE_NOTE_FILE}`);
    for (const child of await listDirectories(projectRoot, top)) {
      found.push(`${top}/${child}/${PACKAGE_NOTE_FILE}`);
    }
  }
  // Only paths that exist count against the limit.
  const existing: string[] = [];
  for (const path of found.sort()) {
    if (existing.length >= AGENT_NOTE_LIMITS.packageNotes) break;
    if (await isFile(join(projectRoot, path))) existing.push(path);
  }
  return existing;
}

async function listDirectories(projectRoot: string, relativeDirectory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(projectRoot, relativeDirectory), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function safeReaddir(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
