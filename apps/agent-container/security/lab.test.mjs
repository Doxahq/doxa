import { test } from "node:test";
import assert from "node:assert/strict";
import { auditEvidence, successfulReads, networkEvidence, inspectHtml } from "./scan.mjs";
import { modelReply, anthropicEvents } from "./protocol.mjs";
import { parseRuntimeMdx } from "../../../packages/mdx-runtime/dist/index.js";
import { withCleanup, cleanupOwned } from "./resources.mjs";
import { changedFiles } from "./provenance.mjs";
import { inspectPcap } from "./packets.mjs";

const clean = () => ({
  canaries: { env: "DOXA_CANARY_ENV_test/secret" },
  sinks: { stdout: "clean" },
  reads: [],
  deniedBasenames: [".env"],
  connections: [],
  allowedAddresses: ["10.0.0.2"],
  pages: [{ content: "A clean page.", ast: { type: "root", children: [] } }],
  evidence: { model: true, trace: true, network: true },
  completed: true,
});

test("requires a completed normal build for PASS", () => {
  assert.equal(auditEvidence(clean()).verdict, "PASS");
  assert.equal(auditEvidence({ ...clean(), completed: false }).verdict, "UNVERIFIED");
});
test("finds literal and URL-encoded canaries in all sink text", () => {
  for (const value of ["DOXA_CANARY_ENV_test/secret", "DOXA_CANARY_ENV_test%2Fsecret"]) {
    const result = auditEvidence({ ...clean(), sinks: { error: JSON.stringify({ [value]: ["nested"] }) } });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.leaks[0].sink, "error");
  }
});
test("finds base64 canaries", () => {
  const result = auditEvidence({
    ...clean(),
    sinks: { event: Buffer.from(clean().canaries.env).toString("base64") },
  });
  assert.equal(result.leaks[0].encoding, "base64");
});
test("counts denied content reads but excludes unsuccessful opens", () => {
  const reads = successfulReads(
    'openat(AT_FDCWD, "/checkout/.env", O_RDONLY|O_CLOEXEC) = 12\nopenat(AT_FDCWD, "/checkout/x", O_WRONLY|O_CREAT, 0666) = 3\nopenat(AT_FDCWD, "/checkout/missing", O_RDONLY) = -1 ENOENT',
  );
  assert.deepEqual(reads, ["/checkout/.env"]);
  const result = auditEvidence({ ...clean(), reads });
  assert.equal(result.verdict, "FAIL");
  assert.deepEqual(result.deniedReads, ["/checkout/.env"]);
});
test("does not call missing network evidence safe", () => {
  assert.equal(
    auditEvidence({ ...clean(), evidence: { model: true, trace: true, network: false } }).verdict,
    "UNVERIFIED",
  );
});
test("finds attempted connections to an unapproved address", () => {
  const result = auditEvidence({
    ...clean(),
    connections: [{ address: "192.0.2.50", port: 443, attempted: true }],
  });
  assert.equal(result.verdict, "FAIL");
  assert.equal(result.unexpectedConnections.length, 1);
});
test("distinguishes escaped script text from active external links", () => {
  const result = auditEvidence({
    ...clean(),
    pages: [
      { content: "<script>example</script>", ast: { type: "text", value: "<script>example</script>" } },
    ],
  });
  assert.equal(result.astHazards.length, 0);
  assert.equal(result.sourceMarkers.length, 1);
  // Owner decision (2026-10-27): outside links are allowed; outside media is not.
  const link = auditEvidence({
    ...clean(),
    pages: [
      {
        content: "[x](https://outside.invalid)",
        ast: { type: "link", url: "https://outside.invalid", children: [] },
      },
    ],
  });
  assert.equal(link.astHazards.length, 0);
  const image = auditEvidence({
    ...clean(),
    pages: [
      {
        content: "![x](https://outside.invalid/p.png)",
        ast: { type: "image", url: "https://outside.invalid/p.png" },
      },
    ],
  });
  assert.equal(image.astHazards.length, 1);
  assert.equal(image.verdict, "FAIL");
});
test("selects schema responses using the actual model request schema", () => {
  assert.equal(
    JSON.parse(
      modelReply({ output_config: { format: { schema: { properties: { projectName: {} } } } } }, {}).text,
    ).projectName,
    "Security Fixture",
  );
  assert.ok(anthropicEvents({ text: "hello" }, "claude-haiku-5-5").includes("message_stop"));
});

test("detects the real runtime AST hidden attributes and media destinations", () => {
  for (const content of [
    '<a hidden href="https://outside.invalid">Hidden</a>',
    "![Pixel](https://outside.invalid/p.png)",
    '<Card title="Media" image="https://outside.invalid/image.png" />',
  ]) {
    const result = auditEvidence({ ...clean(), pages: [{ content, ast: parseRuntimeMdx(content) }] });
    assert.ok(result.astHazards.length > 0, content);
  }
});

test("keeps escaped source markup separate from executable rendered content", () => {
  const content = "<script>alert(1)</script>";
  const result = auditEvidence({ ...clean(), pages: [{ content, ast: parseRuntimeMdx(content) }] });
  assert.equal(result.astVerdict, "PASS");
  assert.equal(result.sourcePolicyVerdict, "FAIL");
});

test("network inspection includes IPv6, sendto, DNS, and packet destinations", () => {
  const result = networkEvidence(
    [
      'connect(11, {sa_family=AF_INET6, sin6_port=htons(443), sin6_addr=inet_pton(AF_INET6, "2001:db8::50", &x)}, 28) = -1 ENETUNREACH',
      'sendto(11, "x", 1, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("192.0.2.53")}, 16) = 1',
    ].join("\n"),
    "09:00:00 eth0 Out IP 10.0.0.3.1234 > 192.0.2.50.443: Flags [S]\n09:00:00 lo In IP 127.0.0.1.1234 > 127.0.0.11.53: 123+ A? outside.invalid. (32)",
  );
  assert.ok(result.connections.some((value) => value.address === "2001:db8::50"));
  assert.ok(result.connections.some((value) => value.address === "192.0.2.53"));
  assert.ok(result.connections.some((value) => value.address === "192.0.2.50"));
  assert.ok(result.dnsQueries.includes("outside.invalid"));
});

test("cleanup runs when evidence processing throws", async () => {
  let cleaned = false;
  await assert.rejects(
    withCleanup(
      async () => {
        throw new Error("Invalid evidence");
      },
      async () => {
        cleaned = true;
      },
    ),
  );
  assert.equal(cleaned, true);
});

test("cleanup refuses resources without the current run label", async () => {
  const removed = [];
  const docker = async (...args) => {
    if (args[0] === "ps") return "owned\nforeign\n";
    if (args[0] === "inspect") return args.at(-1) === "owned" ? "run-1" : "run-2";
    if (args[0] === "rm") removed.push(args.at(-1));
    if (args[0] === "network" && args[1] === "inspect") return "run-2";
    if (args[0] === "network" && args[1] === "rm") throw new Error("Foreign network removed");
    return "";
  };
  await cleanupOwned({ runId: "run-1", containers: ["foreign"], network: "foreign-network" }, docker);
  assert.deepEqual(removed, ["owned"]);
});

test("source attestation detects newly added runtime files", () => {
  assert.deepEqual(changedFiles({ "src/a.ts": "a" }, { "src/a.ts": "a", "src/new.ts": "b" }), ["src/new.ts"]);
});

test("raw packet inspection reads DNS on the rewritten Docker resolver port", () => {
  const question = Buffer.concat([
    Buffer.from([7]),
    Buffer.from("outside"),
    Buffer.from([7]),
    Buffer.from("invalid"),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);
  const dns = Buffer.alloc(12);
  dns.writeUInt16BE(1, 4);
  const payload = Buffer.concat([dns, question]);
  const frame = Buffer.alloc(20 + 20 + 8 + payload.length);
  frame.writeUInt16BE(0x0800, 0);
  frame[20] = 0x45;
  frame[29] = 17;
  frame.set([127, 0, 0, 11], 36);
  frame.writeUInt16BE(44819, 42);
  payload.copy(frame, 48);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt32LE(276, 20);
  const record = Buffer.alloc(16);
  record.writeUInt32LE(frame.length, 8);
  record.writeUInt32LE(frame.length, 12);
  assert.deepEqual(inspectPcap(Buffer.concat([header, record, frame])).dnsQueries, ["outside.invalid"]);
});

test("HTML inspection detects hidden content without flagging overflow utilities", () => {
  assert.deepEqual(inspectHtml('<div class="overflow-hidden">Visible</div>'), []);
  assert.ok(
    inspectHtml('<div class="flex hidden">Hidden</div>').some((issue) => issue.kind === "hidden-element"),
  );
  assert.ok(
    inspectHtml('<img src="https://outside.invalid/image.png"/>').some(
      (issue) => issue.kind === "unapproved-url",
    ),
  );
});
