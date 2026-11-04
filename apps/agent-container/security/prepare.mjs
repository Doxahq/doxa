import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHashes, changedFiles, distHashes } from "./provenance.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, ".artifacts/security-audit");
const image = process.env.DOXA_AUDIT_IMAGE ?? "agent-container:security-lab";
const run = async (args) =>
  (await exec("docker", args, { timeout: 240_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
await mkdir(out, { recursive: true });
const context = JSON.parse(await run(["context", "inspect"]));
if (!context[0]?.Endpoints?.docker?.Host?.startsWith("unix://"))
  throw new Error("This lab requires a local Unix-socket Docker context.");
const hasher =
  "import{sourceHashes}from'/lab/provenance.mjs';console.log(JSON.stringify(await sourceHashes('/app')));";
// Root reads every copied source file, as the image build does; local file modes can be owner-only.
const hashes = JSON.parse(
  await run([
    "run",
    "--rm",
    "--user",
    "root",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--mount",
    `type=bind,source=${join(root, "apps/agent-container/security")},target=/lab,readonly`,
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    hasher,
  ]),
);
const currentSourceHashes = await sourceHashes(root);
const differences = changedFiles(hashes, currentSourceHashes);
const unsupported = differences.filter(
  (path) => !path.startsWith("packages/agent/src/") || !hashes[path] || !currentSourceHashes[path],
);
if (unsupported.length)
  throw new Error(
    `Cached image needs a fresh production build; unsupported source differences: ${unsupported.join(", ")}`,
  );
const parity = {
  compared: Object.keys(hashes).length,
  differences,
  sourceOverlay: differences,
  image,
  imageDigest: (await run(["image", "inspect", "--format", "{{.Id}}", image])).trim(),
  freshImageBuild: false,
};
await writeFile(join(out, "cached-image-source-hashes.json"), JSON.stringify(hashes, null, 2));
await writeFile(join(out, "image-source-parity.json"), JSON.stringify(parity, null, 2));
const dist = join(out, "current-agent-dist");
await mkdir(dist, { recursive: true });
const mounts = differences.flatMap((path) => [
  "--mount",
  `type=bind,source=${join(root, path)},target=/app/${path},readonly`,
]);
await run([
  "run",
  "--rm",
  "--user",
  "root",
  "--platform",
  "linux/amd64",
  "--network",
  "none",
  "--tmpfs",
  "/tmp:rw,size=512m",
  "--tmpfs",
  "/app/packages/agent/dist:rw,size=128m",
  ...mounts,
  "--mount",
  `type=bind,source=${dist},target=/out`,
  "--entrypoint",
  "sh",
  image,
  "-c",
  "pnpm --filter @doxahq/agent build > /out/build.log 2>&1 && cp -a /app/packages/agent/dist/. /out/",
]);
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const tools = join(out, `observer-tools-${arch}`);
await mkdir(tools, { recursive: true });
await run([
  "run",
  "--rm",
  "--user",
  "root",
  "--platform",
  `linux/${arch}`,
  "--tmpfs",
  "/var/lib/apt/lists:rw,size=64m",
  "--tmpfs",
  "/var/cache/apt:rw,size=64m",
  "--tmpfs",
  "/tmp:rw,size=256m",
  "--mount",
  `type=bind,source=${tools},target=/out`,
  "--entrypoint",
  "sh",
  process.env.DOXA_AUDIT_OBSERVER_IMAGE ?? "node:26-slim",
  "-c",
  'apt-get update > /tmp/apt.log && cd /tmp && apt-get download strace tcpdump libpcap0.8t64 libdbus-1-3 libunwind8 liblzma5 > /tmp/download.log && for package in /tmp/*.deb; do dpkg-deb -x "$package" /out; done && cat /tmp/download.log',
]);
console.log(
  `Prepared ${image}; verified ${parity.compared} source/build inputs; rebuilt agent with ${differences.length} current source overlays.`,
);

await writeFile(
  join(out, "prepared-attestation.json"),
  JSON.stringify({ ...parity, currentSourceHashes, distHashes: await distHashes(dist) }, null, 2),
);
