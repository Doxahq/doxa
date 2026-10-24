import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  buildArtifactPrefix,
  manifestPathForPrefix,
  parseDocsManifest,
  type DocsManifest,
} from "@doxahq/docs-engine";

/**
 * Frozen docs artifact sets.
 *
 * Each set under `sets/schema-v{N}/{name}/` is one immutable artifact set
 * exactly as a writer of schema version N published it. The sets never
 * change after they are added. They are the regression gate that proves the
 * evergreen renderer still reads every artifact schema Doxa ever published.
 *
 * See `docs/current/docs-artifact-compatibility.md`.
 */

const SETS_DIRECTORY = fileURLToPath(new URL("../sets/", import.meta.url));
const SCHEMA_DIRECTORY_PREFIX = "schema-v";
const ARTIFACTS_DIRECTORY = "artifacts";
const EXPECTED_DIRECTORY = "expected";
const ROUTE_DATA_DIRECTORY = "route-data";
const SET_FILE = "set.json";

const frozenArtifactSetIdentitySchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    siteId: z.string().min(1),
    versionId: z.string().min(1),
    projectId: z.string().min(1),
    projectSlug: z.string().min(1),
  })
  .strict();

export type FrozenArtifactSetIdentity = z.infer<
  typeof frozenArtifactSetIdentitySchema
>;

/**
 * The pinned resolution a renderer receives for this set. It mirrors the
 * platform `DocsHostResolution` shape without depending on the contracts
 * package, so the fixtures stay usable from every reader.
 */
export interface FrozenArtifactSetResolution {
  siteId: string;
  projectId: string;
  projectSlug: string;
  publishedVersionId: string;
  artifactPrefix: string;
  manifestPath: string;
  accessPolicy: "public";
}

export interface FrozenArtifactSet extends FrozenArtifactSetIdentity {
  /** Absolute path of the set directory. */
  directory: string;
  artifactPrefix: string;
  manifestPath: string;
  manifest: DocsManifest;
  resolution: FrozenArtifactSetResolution;
  /** Every artifact object, keyed by its full R2 key. */
  objects: Readonly<Record<string, string>>;
  /** Absolute path of one golden file under this set's `expected/` folder. */
  expectedPath(...segments: string[]): string;
  /** Absolute path of the golden route data file for one page href. */
  expectedRouteDataPath(href: string): string;
}

/** Loads every frozen set, ordered by schema version and then by name. */
export function listFrozenArtifactSets(): FrozenArtifactSet[] {
  return listSchemaDirectories().flatMap((schemaDirectory) =>
    listChildDirectories(schemaDirectory).map((setDirectory) =>
      loadFrozenArtifactSet(setDirectory),
    ),
  );
}

/** Loads one frozen set by schema version and name. */
export function loadFrozenArtifactSetByName(
  schemaVersion: number,
  name: string,
): FrozenArtifactSet {
  return loadFrozenArtifactSet(
    join(SETS_DIRECTORY, `${SCHEMA_DIRECTORY_PREFIX}${schemaVersion}`, name),
  );
}

/**
 * Maps a page href to a stable snapshot file name: `/` becomes `index.json`
 * and `/guides/setup` becomes `guides__setup.json`.
 */
export function routeDataSnapshotFileName(href: string): string {
  const segments = href.split("/").filter(Boolean);
  return `${segments.length === 0 ? "index" : segments.join("__")}.json`;
}

function loadFrozenArtifactSet(directory: string): FrozenArtifactSet {
  const identity = readIdentity(directory);
  assertDirectoryMatchesIdentity(directory, identity);

  const artifactPrefix = buildArtifactPrefix(
    identity.siteId,
    identity.versionId,
  );
  const manifestPath = manifestPathForPrefix(artifactPrefix);
  const objects = readArtifactObjects(
    join(directory, ARTIFACTS_DIRECTORY),
    artifactPrefix,
  );
  const manifest = readManifest(objects, manifestPath, identity);

  return {
    ...identity,
    directory,
    artifactPrefix,
    manifestPath,
    manifest,
    objects,
    resolution: {
      siteId: identity.siteId,
      projectId: identity.projectId,
      projectSlug: identity.projectSlug,
      publishedVersionId: identity.versionId,
      artifactPrefix,
      manifestPath,
      accessPolicy: "public",
    },
    expectedPath: (...segments) =>
      join(directory, EXPECTED_DIRECTORY, ...segments),
    expectedRouteDataPath: (href) =>
      join(
        directory,
        EXPECTED_DIRECTORY,
        ROUTE_DATA_DIRECTORY,
        routeDataSnapshotFileName(href),
      ),
  };
}

function readIdentity(directory: string): FrozenArtifactSetIdentity {
  const raw = readFileSync(join(directory, SET_FILE), "utf8");
  return frozenArtifactSetIdentitySchema.parse(JSON.parse(raw));
}

function assertDirectoryMatchesIdentity(
  directory: string,
  identity: FrozenArtifactSetIdentity,
): void {
  const expected = join(
    SETS_DIRECTORY,
    `${SCHEMA_DIRECTORY_PREFIX}${identity.schemaVersion}`,
    identity.name,
  );
  if (resolve(directory) !== resolve(expected)) {
    throw new Error(
      `Frozen artifact set "${identity.name}" must live at ${relative(SETS_DIRECTORY, expected)}, found ${relative(SETS_DIRECTORY, directory)}.`,
    );
  }
}

function readManifest(
  objects: Readonly<Record<string, string>>,
  manifestPath: string,
  identity: FrozenArtifactSetIdentity,
): DocsManifest {
  const raw = objects[manifestPath];
  if (raw === undefined) {
    throw new Error(
      `Frozen artifact set "${identity.name}" has no ${manifestPath}.`,
    );
  }

  const parsed = parseDocsManifest(JSON.parse(raw));
  if (!parsed.ok) {
    throw new Error(
      `Frozen artifact set "${identity.name}" has an unreadable manifest: ${parsed.reason}.`,
    );
  }
  if (parsed.manifest.schemaVersion !== identity.schemaVersion) {
    throw new Error(
      `Frozen artifact set "${identity.name}" declares schema version ${identity.schemaVersion} but its manifest carries ${parsed.manifest.schemaVersion}.`,
    );
  }
  return parsed.manifest;
}

function readArtifactObjects(
  artifactsDirectory: string,
  artifactPrefix: string,
): Record<string, string> {
  const objects: Record<string, string> = {};
  for (const filePath of listFilesRecursively(artifactsDirectory)) {
    const relativePath = relative(artifactsDirectory, filePath)
      .split(sep)
      .join("/");
    objects[`${artifactPrefix}/${relativePath}`] = readFileSync(
      filePath,
      "utf8",
    );
  }
  return objects;
}

function listSchemaDirectories(): string[] {
  return listChildDirectories(SETS_DIRECTORY)
    .filter((directory) =>
      relative(SETS_DIRECTORY, directory).startsWith(SCHEMA_DIRECTORY_PREFIX),
    )
    .sort((left, right) => schemaVersionOf(left) - schemaVersionOf(right));
}

function schemaVersionOf(schemaDirectory: string): number {
  return Number(
    relative(SETS_DIRECTORY, schemaDirectory).slice(
      SCHEMA_DIRECTORY_PREFIX.length,
    ),
  );
}

function listChildDirectories(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .filter((entry) => statSync(entry).isDirectory())
    .sort();
}

function listFilesRecursively(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const entryPath = join(directory, entry);
      return statSync(entryPath).isDirectory()
        ? listFilesRecursively(entryPath)
        : [entryPath];
    });
}
