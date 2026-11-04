import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  LD_LIBRARY_PATH:
    process.arch === "arm64" ? "/tools/usr/lib/aarch64-linux-gnu" : "/tools/usr/lib/x86_64-linux-gnu",
};
const children = [];
const capture = spawn(
  "/tools/usr/bin/tcpdump",
  ["-Z", "root", "-U", "-n", "-i", "any", "-w", "/evidence/network.pcap"],
  { env, stdio: ["ignore", "ignore", "inherit"] },
);
children.push(capture);
const pids = readdirSync("/proc")
  .filter((name) => /^\d+$/.test(name))
  .filter((name) => {
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8");
      return Number(name) !== process.pid && cmd.includes("node") && cmd.includes("src/index.ts");
    } catch {
      return false;
    }
  });
if (!pids.length) throw new Error("No production agent process found for syscall recording.");
const trace = spawn(
  "/tools/usr/bin/strace",
  [
    "-f",
    "-ff",
    "-s",
    "1024",
    "-e",
    "trace=openat,openat2,connect,sendto,execve",
    "-o",
    "/evidence/trace",
    ...pids.flatMap((pid) => ["-p", pid]),
  ],
  { env, stdio: ["ignore", "ignore", "inherit"] },
);
children.push(trace);
setTimeout(() => {
  if (children.some((child) => child.exitCode !== null)) {
    process.exitCode = 1;
    return;
  }
  writeFileSync(
    "/evidence/observer-ready.json",
    JSON.stringify({ pids, packetPid: capture.pid, tracePid: trace.pid }),
  );
  console.log("Packet and syscall observers ready");
}, 600);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    children.forEach((child) => child.kill("SIGINT"));
    setTimeout(() => process.exit(), 400);
  });
