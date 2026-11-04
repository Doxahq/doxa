import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const lab = dirname(fileURLToPath(import.meta.url));
const root = resolve(lab, "../../..");
const exec = promisify(execFile);
const child = spawn(process.execPath, [join(lab, "run.mjs"), "--case", "baseline"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
let campaign;
child.stdout.on("data", (value) => {
  stdout += value;
  campaign = /Evidence: (.+)/.exec(stdout)?.[1];
});
child.stderr.on("data", (value) => {
  stderr += value;
});
const exited = new Promise((done) => child.on("close", (code) => done(code)));
const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  if (campaign) {
    try {
      await readFile(join(campaign, "baseline/evidence/observer-ready.json"));
      ready = true;
      break;
    } catch {}
  }
  if (child.exitCode !== null) break;
  await new Promise((done) => setTimeout(done, 250));
}
if (!ready) {
  child.kill("SIGTERM");
  throw new Error(`Observer did not become ready for interruption test: ${stderr}`);
}
child.kill("SIGTERM");
const code = await Promise.race([
  exited,
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Interrupted driver did not exit.")), 30_000);
    timer.unref();
  }),
]);
const evidence = JSON.parse(await readFile(join(campaign, "baseline/evidence/interrupted.json"), "utf8"));
const containers = (
  await exec("docker", [
    "ps",
    "-a",
    "--filter",
    `label=doxa.security.run=${evidence.runId}`,
    "--format",
    "{{.Names}}",
  ])
).stdout.trim();
const networks = (
  await exec("docker", [
    "network",
    "ls",
    "--filter",
    `label=doxa.security.run=${evidence.runId}`,
    "--format",
    "{{.Name}}",
  ])
).stdout.trim();
const result = {
  runId: evidence.runId,
  campaign,
  code,
  containers,
  networks,
  pass: code === 130 && !containers && !networks,
};
await writeFile(
  join(root, ".artifacts/security-audit/interruption-selftest.json"),
  JSON.stringify(result, null, 2),
);
await writeFile(join(root, ".artifacts/security-audit/interruption-selftest.log"), `${stdout}\n${stderr}`);
if (!result.pass) throw new Error(JSON.stringify(result));
console.log("PASS interruption preserves evidence and removes only owned resources.");
