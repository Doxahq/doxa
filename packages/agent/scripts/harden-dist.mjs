import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const distDir = new URL("../dist", import.meta.url);

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

async function removeChildDirectories(dir) {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await rm(join(dir, entry.name), { recursive: true, force: true });
    }
  }
}

function stripSourceMapComments(code) {
  return code.replace(/\n?\/\/# sourceMappingURL=.*\.map\s*$/gm, "");
}

function stripDeclarationComments(code) {
  return code
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\n/gm, "");
}

function obfuscateJavaScript(code, fileName) {
  return JavaScriptObfuscator.obfuscate(stripSourceMapComments(code), {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    ignoreImports: true,
    identifierNamesGenerator: "hexadecimal",
    log: false,
    numbersToExpressions: false,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: false,
    simplify: true,
    sourceMap: false,
    splitStrings: true,
    splitStringsChunkLength: 16,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.75,
    stringArrayEncoding: ["base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 1,
    target: "node",
  }).getObfuscatedCode();
}

if (!existsSync(distDir)) {
  throw new Error("Cannot harden dist because dist/ does not exist.");
}

for (const file of await walk(distDir.pathname)) {
  if (file.endsWith(".map")) {
    await rm(file, { force: true });
    continue;
  }

  const fileStat = await stat(file);
  if (!fileStat.isFile()) continue;

  const extension = extname(file);
  if (extension === ".js") {
    const code = await readFile(file, "utf-8");
    await writeFile(file, `${obfuscateJavaScript(code, file)}\n`, "utf-8");
  } else if (file.endsWith(".d.ts")) {
    const declarations = await readFile(file, "utf-8");
    await writeFile(file, stripDeclarationComments(declarations), "utf-8");
  }
}

await removeChildDirectories(distDir.pathname);
