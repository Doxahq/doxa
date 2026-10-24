import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Runs one Docker CLI command and returns its trimmed standard output. */
export type DockerCommand = (args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

export const runDocker: DockerCommand = async (args) => {
  const { stdout } = await execFileAsync("docker", [...args], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
};

/** The label of every Docker object of a local job run, so the dev script can remove stale ones. */
export const LOCAL_JOB_LABEL = "doxa.utility.run";

/** The memory of the `basic` instance type that the job uses in production. */
const JOB_MEMORY_MB = 1024;
const RELAY_MEMORY_MB = 64;
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 200;

/** The flags of both containers: no new privileges, no capabilities, no writes. */
const LOCKED_DOWN = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64"];

export interface LocalJobContainerSpec {
  /** The job name, as in `UTILITY_JOBS`; the job container answers to it on the run network. */
  job: string;
  image: string;
  /** The port of the job supervisor. */
  port: number;
  runId: string;
}

/**
 * The container of one job run on local Docker, built like production: the
 * job runs on an internal network of its own, with no internet, no
 * environment and 1 GiB of memory. A relay on the default network forwards
 * one port of 127.0.0.1 to it, as the gate does in production, and is the
 * only way in. Docker cannot publish a port of a container on an internal
 * network, so the relay is needed.
 */
export class LocalJobContainer {
  private started?: Promise<string>;

  constructor(
    private readonly spec: LocalJobContainerSpec,
    private readonly docker: DockerCommand = runDocker,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The base URL of the job, starting the containers on first use. */
  baseUrl(): Promise<string> {
    this.started ??= this.start().catch(async (error: unknown) => {
      await this.stop();
      throw error;
    });
    return this.started;
  }

  /** Removes the containers and the network of the run. Safe to call more than once. */
  async stop(): Promise<void> {
    this.started = undefined;
    const names = this.names();
    await this.docker(["rm", "-f", names.relay, names.job]).catch(() => undefined);
    await this.docker(["network", "rm", names.network]).catch(() => undefined);
  }

  private async start(): Promise<string> {
    const { job, image, port, runId } = this.spec;
    const names = this.names();
    const label = ["--label", `${LOCAL_JOB_LABEL}=${runId}`];

    await this.docker(["network", "create", "--internal", ...label, names.network]);
    await this.docker([
      "run", "-d", "--rm", "--name", names.job, ...label,
      "--network", names.network, "--network-alias", job,
      "--memory", `${JOB_MEMORY_MB}m`, ...LOCKED_DOWN,
      image,
    ]);
    await this.docker([
      "run", "-d", "--rm", "--name", names.relay, ...label,
      "-p", `127.0.0.1::${port}`,
      "--memory", `${RELAY_MEMORY_MB}m`, ...LOCKED_DOWN,
      "--entrypoint", "node", image, "-e", relayScript(job, port),
    ]);
    await this.docker(["network", "connect", names.network, names.relay]);

    const published = (await this.docker(["port", names.relay, `${port}/tcp`])).split("\n")[0]?.trim();
    if (!published) throw new Error(`Docker published no port for the ${job} relay.`);
    const baseUrl = `http://${published}`;
    await this.waitUntilReady(baseUrl);
    return baseUrl;
  }

  /** Any HTTP answer means the supervisor listens; a reset means the relay could not reach it yet. */
  private async waitUntilReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const answered = await this.fetchImpl(`${baseUrl}/`, { signal: AbortSignal.timeout(1_000) })
        .then(() => true, () => false);
      if (answered) return;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    throw new Error(`The ${this.spec.job} job did not start within ${READY_TIMEOUT_MS / 1_000} seconds.`);
  }

  private names(): { network: string; job: string; relay: string } {
    const base = `doxa-${this.spec.job}-${this.spec.runId}`;
    return { network: base, job: base, relay: `${base}-relay` };
  }
}

/** A TCP relay of one port to the job on the run network, in plain Node. */
function relayScript(host: string, port: number): string {
  return [
    'const net = require("node:net");',
    "net.createServer((client) => {",
    `  const job = net.connect(${port}, ${JSON.stringify(host)});`,
    "  const close = () => { client.destroy(); job.destroy(); };",
    '  client.on("error", close); job.on("error", close);',
    "  client.pipe(job).pipe(client);",
    `}).listen(${port});`,
  ].join("\n");
}
