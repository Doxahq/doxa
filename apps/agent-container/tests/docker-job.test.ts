import { describe, expect, test } from "vitest";
import { LocalJobContainer, type DockerCommand } from "../src/utility/docker-job";
import { createDockerSpecReaderClient } from "../src/utility/spec-reader-client";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NAME = `doxa-spec-reader-${RUN_ID}`;
const SPEC = { job: "spec-reader", image: "doxa-spec-reader:dev", port: 8790, runId: RUN_ID };
const INPUT = { roots: ["openapi.yaml"], files: { "openapi.yaml": "openapi: 3.1.0\n" } };

/** A Docker CLI that records each command and publishes the relay on port 55000. */
function fakeDocker(failOn?: string): { docker: DockerCommand; commands: string[][] } {
  const commands: string[][] = [];
  const docker: DockerCommand = async (args) => {
    commands.push([...args]);
    if (failOn && args.join(" ").startsWith(failOn)) throw new Error(`${failOn} failed`);
    return args[0] === "port" ? "127.0.0.1:55000\n[::1]:55000" : "";
  };
  return { docker, commands };
}

const answeringFetch: typeof fetch = async (input) =>
  new URL(input instanceof Request ? input.url : String(input)).pathname === "/run"
    ? new Response(JSON.stringify({ ok: true, output: { status: "need_files", needFiles: ["a.yaml"] } }))
    : new Response(null, { status: 404 });

describe("local job container", () => {
  test("runs the job on an internal network, locked down, behind a relay of one local port", async () => {
    const { docker, commands } = fakeDocker();

    await expect(new LocalJobContainer(SPEC, docker, answeringFetch).baseUrl()).resolves.toBe("http://127.0.0.1:55000");

    const [network, job, relay, connect] = commands;
    expect(network).toEqual(["network", "create", "--internal", "--label", `doxa.utility.run=${RUN_ID}`, NAME]);
    expect(job).toEqual(expect.arrayContaining(["--network", NAME, "--network-alias", "spec-reader", "--read-only", "--memory", "1024m"]));
    expect(job).not.toContain("-p");
    expect(job).not.toContain("-e");
    expect(job?.at(-1)).toBe("doxa-spec-reader:dev");
    expect(relay).toEqual(expect.arrayContaining(["--name", `${NAME}-relay`, "-p", "127.0.0.1::8790", "--read-only"]));
    expect(connect).toEqual(["network", "connect", NAME, `${NAME}-relay`]);
  });

  test("starts once for all calls of a run and removes everything on done", async () => {
    const { docker, commands } = fakeDocker();
    const client = createDockerSpecReaderClient(new LocalJobContainer(SPEC, docker, answeringFetch), answeringFetch);

    await expect(client.read(INPUT)).resolves.toEqual({ ok: true, output: { status: "need_files", needFiles: ["a.yaml"] } });
    await client.read(INPUT);
    await client.done();

    expect(commands.filter((command) => command[0] === "network" && command[1] === "create")).toHaveLength(1);
    expect(commands.slice(-2)).toEqual([["rm", "-f", `${NAME}-relay`, NAME], ["network", "rm", NAME]]);
  });

  test("reports a container that did not start as a failed call and cleans up", async () => {
    const { docker, commands } = fakeDocker("run -d --rm --name doxa-spec-reader");
    const client = createDockerSpecReaderClient(new LocalJobContainer(SPEC, docker, answeringFetch), answeringFetch);

    await expect(client.read(INPUT)).resolves.toMatchObject({ ok: false, code: "docker_unavailable" });
    expect(commands.slice(-2)).toEqual([["rm", "-f", `${NAME}-relay`, NAME], ["network", "rm", NAME]]);
  });
});
