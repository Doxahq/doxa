// Reports what the sandbox lets a job do.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

for await (const _chunk of process.stdin) {
  // Read and drop the input.
}
const results = {};
const attempt = async (name, run) => {
  try {
    await run();
    results[name] = "allowed";
  } catch {
    results[name] = "denied";
  }
};
await attempt("fetch", () => fetch("http://127.0.0.1:9/"));
await attempt("tcp", () => new Promise((resolve, reject) => {
  const socket = connect(9, "127.0.0.1");
  socket.on("connect", resolve);
  socket.on("error", reject);
}));
await attempt("readOutside", () => readFileSync("/etc/hosts"));
await attempt("write", () => writeFileSync(new URL("./written.txt", import.meta.url), "x"));
await attempt("childProcess", () => execFileSync("/bin/echo", ["hi"]));
await attempt("eval", () => eval("1 + 1"));
results.environmentKeys = Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").length;
results.proto = Object.hasOwn(Object.prototype, "__proto__") ? "present" : "deleted";
process.stdout.write(JSON.stringify({ ok: true, output: results }));
