import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const packageRoot = new URL("..", import.meta.url).pathname;
const distDir = join(packageRoot, "dist");
const packageJsonPath = join(packageRoot, "package.json");
const requiredFiles = new Set(["index.d.ts", "index.js", "node.d.ts", "node.js", "structure.d.ts", "structure.js"]);
const requiredRuntimeFiles = new Set([
  "mdx-validator-core.mjs",
  "mdx-validator-server.mjs",
  "mdx-validator.mjs",
]);
const forbiddenPhrases = [
  "You are a code analysis expert",
  "You are an expert technical documentation writer",
  "Frontmatter values must be plain text",
  "Output only a complete valid JSON analysis object",
  "documentationIntent.canonicalWorkflows must capture",
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(file));
    } else {
      files.push(file);
    }
  }

  return files;
}

function fail(message) {
  throw new Error(`Dist hardening assertion failed: ${message}`);
}

if (!existsSync(distDir)) fail("dist/ does not exist");
if (existsSync(join(distDir, "prompts"))) fail("dist/prompts exists");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf-8"));
if (packageJson.exports?.["./prompts"]) fail("package exports still exposes ./prompts");

const files = await walk(distDir);
const foundFiles = new Set(files.map((file) => basename(file)));
for (const file of requiredFiles) {
  if (!foundFiles.has(file)) fail(`required dist file is missing: ${file}`);
}
for (const file of requiredRuntimeFiles) {
  if (!existsSync(join(packageRoot, "runtime", file))) {
    fail(`required runtime file is missing: runtime/${file}`);
  }
}

for (const file of files) {
  const rel = relative(distDir, file);
  if (rel.includes("/")) fail(`dist contains nested file ${rel}`);
  if (!file.endsWith(".js") && !file.endsWith(".d.ts")) fail(`unexpected dist file ${rel}`);
  if (file.endsWith(".map")) fail(`source map found at ${rel}`);

  const fileStat = await stat(file);
  if (!fileStat.isFile()) fail(`non-file dist entry found at ${rel}`);

  const content = await readFile(file, "utf-8");
  if (content.includes("sourceMappingURL")) fail(`sourceMappingURL comment found in ${rel}`);

  if (file.endsWith(".js")) {
    for (const phrase of forbiddenPhrases) {
      if (content.includes(phrase)) fail(`raw prompt phrase found in ${rel}: ${phrase}`);
    }
  }
}

// The structure entry runs in Cloudflare Workers, so it must be self-contained:
// any import could bring in a Node module.
const structureEntry = await readFile(join(distDir, "structure.js"), "utf-8");
if (/\bimport\s*\(|\bfrom\s*["']|\brequire\s*\(/.test(structureEntry)) {
  fail("dist/structure.js imports a module; it must stay Worker-safe");
}
