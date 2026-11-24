import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MODEL_PROVIDERS } from "@doxahq/contracts";
import { describe, expect, test } from "vitest";
import {
  agentEgressAllowList,
  agentEgressContainerSettings,
  AgentEgressLogBook,
  createAgentEgressGate,
  decideAgentEgress,
  loggableEgressHost,
  MODEL_PROVIDER_BASE_URLS,
  normalizeEgressHost,
  parseAgentEgressMode,
  type AgentEgressEnv,
} from "../src/egress";

const CONTAINER_ID = "container-1";

function gate() {
  const forwarded: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const handler = createAgentEgressGate({
    fetch: async (request) => {
      forwarded.push(request.url);
      return new Response("upstream");
    },
    log: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const call = (url: string, env: AgentEgressEnv, containerId = CONTAINER_ID) =>
    handler(new Request(url), env, { containerId });
  return { call, forwarded, lines };
}

describe("egress mode", () => {
  test("reads log, enforce and off", () => {
    expect(parseAgentEgressMode("log")).toBe("log");
    expect(parseAgentEgressMode("enforce")).toBe("enforce");
    expect(parseAgentEgressMode(" ENFORCE ")).toBe("enforce");
    expect(parseAgentEgressMode("off")).toBe("off");
  });

  test("an unset or unknown value means off", () => {
    expect(parseAgentEgressMode(undefined)).toBe("off");
    expect(parseAgentEgressMode("")).toBe("off");
    expect(parseAgentEgressMode("block")).toBe("off");
    expect(parseAgentEgressMode("enforced")).toBe("off");
  });

  test("only enforce turns off direct internet; only off skips HTTPS interception", () => {
    expect(agentEgressContainerSettings({})).toEqual({ mode: "off", enableInternet: true, interceptHttps: false });
    expect(agentEgressContainerSettings({ AGENT_EGRESS_MODE: "log" })).toEqual({
      mode: "log",
      enableInternet: true,
      interceptHttps: true,
    });
    expect(agentEgressContainerSettings({ AGENT_EGRESS_MODE: "enforce" })).toEqual({
      mode: "enforce",
      enableInternet: false,
      interceptHttps: true,
    });
    expect(agentEgressContainerSettings({ AGENT_EGRESS_MODE: "off" })).toEqual({
      mode: "off",
      enableInternet: true,
      interceptHttps: false,
    });
  });
});

describe("egress allow list", () => {
  test("holds GitHub and every model provider host", () => {
    expect([...agentEgressAllowList({})].sort()).toEqual(["api.anthropic.com", "github.com", "openrouter.ai"]);
  });

  test("adds configured hosts and base URLs", () => {
    const hosts = agentEgressAllowList({
      AGENT_EGRESS_ALLOWED_HOSTS: "Gateway.Example.com., https://models.example.net/v1 , ,bad host",
    });
    expect(hosts.has("gateway.example.com")).toBe(true);
    expect(hosts.has("models.example.net")).toBe(true);
    expect(hosts.has("bad host")).toBe(false);
  });

  test("ignores entries with credentials", () => {
    expect(normalizeEgressHost("https://user:pass@example.com")).toBeNull();
    expect(normalizeEgressHost("   ")).toBeNull();
  });

  test("has a base URL for every model provider, equal to the agent package defaults", async () => {
    expect(Object.keys(MODEL_PROVIDER_BASE_URLS).sort()).toEqual([...MODEL_PROVIDERS].sort());
    const providersDir = new URL("../../../packages/agent/src/core/providers/", import.meta.url);
    const defaults: string[] = [];
    for (const file of await readdir(providersDir)) {
      const source = await readFile(new URL(file, providersDir), "utf8");
      for (const match of source.matchAll(/defaultBaseUrl:\s*"([^"]+)"/g)) defaults.push(match[1]!);
    }
    expect(defaults.sort()).toEqual(Object.values(MODEL_PROVIDER_BASE_URLS).sort());
  });

  test("covers the hosts that the security lab stands in for", async () => {
    const lab = await readFile(new URL("../security/run.mjs", import.meta.url), "utf8");
    const listed = lab.match(/allowedHosts:\s*\[([^\]]*)\]/)?.[1];
    expect(listed).toBeDefined();
    const labHosts = [...listed!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(labHosts.length).toBeGreaterThan(0);
    const allowList = agentEgressAllowList({});
    for (const host of labHosts) expect(allowList.has(host)).toBe(true);
  });
});

describe("egress decision", () => {
  const allowList = agentEgressAllowList({});

  test("allows a listed host over HTTPS", () => {
    expect(decideAgentEgress(new URL("https://github.com/acme/app.git/info/refs"), allowList)).toEqual({
      allowed: true,
      host: "github.com",
    });
    expect(decideAgentEgress(new URL("https://API.anthropic.com./v1/messages"), allowList).allowed).toBe(true);
  });

  test("refuses a host that is not listed", () => {
    expect(decideAgentEgress(new URL("https://attacker.example/collect"), allowList)).toEqual({
      allowed: false,
      host: "attacker.example",
      reason: "host_not_listed",
    });
  });

  test("refuses look-alike hosts and IP addresses", () => {
    for (const url of [
      "https://github.com.attacker.example/",
      "https://api.github.com/",
      "https://raw.githubusercontent.com/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
    ]) {
      expect(decideAgentEgress(new URL(url), allowList).allowed).toBe(false);
    }
  });

  test("refuses a listed host over plain HTTP", () => {
    expect(decideAgentEgress(new URL("http://github.com/acme/app.git"), allowList)).toEqual({
      allowed: false,
      host: "github.com",
      reason: "insecure_scheme",
    });
  });
});

const LOG = { AGENT_EGRESS_MODE: "log" };

describe("egress gate", () => {
  test("log mode forwards every host and logs each host once per run", async () => {
    const { call, forwarded, lines } = gate();

    await call("https://github.com/acme/app.git/info/refs", LOG);
    await call("https://github.com/acme/app.git/git-upload-pack", LOG);
    const response = await call("https://attacker.example/collect?token=x", LOG);
    await call("https://github.com/acme/app.git/info/refs", LOG, "container-2");

    expect(await response.text()).toBe("upstream");
    expect(forwarded).toHaveLength(4);
    expect(lines).toEqual([
      expect.objectContaining({ eventType: "agent_egress", mode: "log", host: "github.com", listed: true, outcome: "forwarded" }),
      expect.objectContaining({
        eventType: "agent_egress",
        mode: "log",
        host: "attacker.example",
        listed: false,
        reason: "host_not_listed",
        outcome: "forwarded",
      }),
      expect.objectContaining({ containerId: "container-2", host: "github.com" }),
    ]);
  });

  test("a log line has the host, never the path or the query", async () => {
    const { call, lines } = gate();
    await call("https://attacker.example/secret-path?token=ghs_secret", {});
    const text = JSON.stringify(lines);
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("ghs_secret");
  });

  test("enforce mode forwards listed hosts and refuses others with a clear error", async () => {
    const { call, forwarded, lines } = gate();
    const env = { AGENT_EGRESS_MODE: "enforce" };

    const allowed = await call("https://api.anthropic.com/v1/messages", env);
    const refused = await call("https://attacker.example/collect", env);
    const insecure = await call("http://github.com/acme/app.git", env);

    expect(await allowed.text()).toBe("upstream");
    expect(forwarded).toEqual(["https://api.anthropic.com/v1/messages"]);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-doxa-egress")).toBe("refused");
    expect(await refused.text()).toContain("attacker.example: this host is not on the egress allow list");
    expect(insecure.status).toBe(403);
    expect(await insecure.text()).toContain("allowed only over HTTPS");
    expect(lines).toEqual([
      expect.objectContaining({ eventType: "agent_egress", mode: "enforce", host: "api.anthropic.com", outcome: "forwarded" }),
      expect.objectContaining({ eventType: "agent_egress_refused", host: "attacker.example", outcome: "refused" }),
      expect.objectContaining({ eventType: "agent_egress_refused", host: "github.com", reason: "insecure_scheme" }),
    ]);
  });

  test("enforce mode forwards a host from AGENT_EGRESS_ALLOWED_HOSTS", async () => {
    const { call, forwarded } = gate();
    const response = await call("https://gateway.example.com/v1/messages", {
      AGENT_EGRESS_MODE: "enforce",
      AGENT_EGRESS_ALLOWED_HOSTS: "https://gateway.example.com/v1",
    });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  test("enforce mode refuses repeated calls but logs the host once", async () => {
    const { call, lines } = gate();
    const env = { AGENT_EGRESS_MODE: "enforce" };
    for (let index = 0; index < 3; index += 1) {
      expect((await call("https://attacker.example/", env)).status).toBe(403);
    }
    expect(lines).toHaveLength(1);
  });

  test("off mode forwards without logs", async () => {
    const { call, forwarded, lines } = gate();
    await call("https://attacker.example/", { AGENT_EGRESS_MODE: "off" });
    expect(forwarded).toHaveLength(1);
    expect(lines).toHaveLength(0);
  });

  test("caps the logged hosts of one run", async () => {
    const { call, lines } = gate();
    for (let index = 0; index < 70; index += 1) await call(`https://h${index}.example/`, LOG);
    expect(lines).toHaveLength(65);
    expect(lines.at(-1)).toEqual(expect.objectContaining({ eventType: "agent_egress_log_capped", maxHosts: 64 }));
  });

  test("hides a long label, which could carry a token", () => {
    const token = "ghs_" + "a".repeat(36);
    expect(loggableEgressHost(`${token}.attacker.example`)).toBe("[label:40].attacker.example");
  });

  test("the log book forgets the oldest run past its limit", () => {
    const book = new AgentEgressLogBook();
    expect(book.record("run-0", "https://github.com:")).toBe("log");
    for (let index = 1; index <= 256; index += 1) book.record(`run-${index}`, "https://github.com:");
    expect(book.record("run-0", "https://github.com:")).toBe("log");
  });
});

describe("egress CA entrypoint", () => {
  const script = new URL("../scripts/trust-egress-ca.sh", import.meta.url).pathname;
  const run = promisify(execFile);
  const printEnv = ["node", "-e", "console.log(JSON.stringify({n:process.env.NODE_EXTRA_CA_CERTS??null,g:process.env.GIT_SSL_CAINFO??null}))"];

  test("trusts the egress CA for Node and git when the runtime provides it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doxa-egress-ca-"));
    await writeFile(join(dir, "system.crt"), "SYSTEM\n");
    await writeFile(join(dir, "egress.crt"), "EGRESS\n");
    const { stdout } = await run("sh", [script, ...printEnv], {
      env: {
        ...process.env,
        TMPDIR: dir,
        DOXA_EGRESS_CA_FILE: join(dir, "egress.crt"),
        DOXA_SYSTEM_CA_FILE: join(dir, "system.crt"),
      },
    });
    const result = JSON.parse(stdout) as { n: string; g: string };
    expect(result.n).toBe(join(dir, "egress.crt"));
    expect(await readFile(result.g, "utf8")).toBe("SYSTEM\nEGRESS\n");
  });

  test("changes nothing without the egress CA", async () => {
    const { stdout } = await run("sh", [script, ...printEnv], {
      env: {
        ...process.env,
        DOXA_EGRESS_CA_FILE: "/nonexistent/egress.crt",
        NODE_EXTRA_CA_CERTS: "/audit-ca.crt",
        GIT_SSL_CAINFO: "/audit-ca.crt",
      },
    });
    expect(JSON.parse(stdout)).toEqual({ n: "/audit-ca.crt", g: "/audit-ca.crt" });
  });
});
