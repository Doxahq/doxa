import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export async function sourceHashes(root) {
  const files = {};
  const add = async (path) => {
    try {
      files[path] = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
    } catch {}
  };
  const walk = async (path) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(`${path}/${entry.name}`);
      else if (entry.isFile()) await add(`${path}/${entry.name}`);
    }
  };
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `packages/${entry.name}`;
    for (const directory of ["src", "runtime", "scripts"]) await walk(`${path}/${directory}`);
    for (const name of await readdir(join(root, path)))
      if (/^(?:package\.json|tsconfig.*\.json|tsup\.config\.[cm]?[jt]s)$/.test(name))
        await add(`${path}/${name}`);
  }
  await walk("apps/agent-container/src");
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "apps/agent-container/Dockerfile",
    "apps/agent-container/package.json",
    "apps/agent-container/tsconfig.json",
  ])
    await add(path);
  return files;
}

export function changedFiles(first, second) {
  return [...new Set([...Object.keys(first), ...Object.keys(second)])]
    .filter((path) => first[path] !== second[path])
    .sort();
}

export async function distHashes(directory) {
  const result = {};
  for (const name of await readdir(directory))
    if (/\.(?:js|ts|map)$/.test(name))
      result[name] = createHash("sha256")
        .update(await readFile(join(directory, name)))
        .digest("hex");
  return result;
}

export async function verifyPrepared(root, directory, imageDigest) {
  const attestation = JSON.parse(await readFile(join(directory, "prepared-attestation.json"), "utf8"));
  if (attestation.imageDigest !== imageDigest)
    throw new Error("Prepared image digest changed. Run prepare.mjs again.");
  const changes = changedFiles(attestation.currentSourceHashes, await sourceHashes(root));
  if (changes.length) throw new Error(`Source changed after preparation: ${changes.join(", ")}`);
  const buildChanges = changedFiles(
    attestation.distHashes,
    await distHashes(join(directory, "current-agent-dist")),
  );
  if (buildChanges.length) throw new Error("Prepared agent build output changed. Run prepare.mjs again.");
  return attestation;
}
