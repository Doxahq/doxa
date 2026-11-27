// Reads what a release needs to know about one Wrangler config: the Worker
// name, the newest Durable Object migration tag and whether it runs
// containers. A release stages a Worker with the same arguments that
// `wrangler deploy` gets, so the config comes from those arguments.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where a Wrangler command runs, relative to the repo root, and its config
 * arguments (for example `--config wrangler.docs-resolver.json --env production`).
 *
 * @typedef {{ cwd: string, args: string[] }} WranglerTarget
 */

/**
 * @typedef {object} WorkerDescription
 * @property {string} configFile the config, relative to the repo root
 * @property {string} workerName the Worker that the config deploys
 * @property {string | null} migrationTag the tag of the newest Durable Object migration
 * @property {boolean} hasContainers
 */

const DEFAULT_CONFIG_FILE = "wrangler.json";

/**
 * @param {string} root the repo root
 * @param {WranglerTarget} target
 * @returns {WorkerDescription}
 */
export function readWranglerTarget(root, target) {
  const { config, env } = parseConfigArgs(target.args);
  const configPath = path.resolve(root, target.cwd, config ?? DEFAULT_CONFIG_FILE);
  const configFile = path.relative(root, configPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the Wrangler config ${configFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { configFile, ...describeWranglerConfig(parsed, env, configFile) };
}

/**
 * The release facts of a parsed config. A key under `env.<env>` wins over the
 * top level. Without `env.<env>.name`, Wrangler names the Worker
 * `<name>-<env>`.
 *
 * @param {Record<string, any>} config
 * @param {string | undefined} env
 * @param {string} label
 * @returns {Omit<WorkerDescription, "configFile">}
 */
export function describeWranglerConfig(config, env, label = "the config") {
  const scoped = env === undefined ? {} : config.env?.[env];
  if (!scoped) throw new Error(`${label} has no env.${env}.`);
  const baseName = config.name;
  if (typeof baseName !== "string" || baseName === "") throw new Error(`${label} has no Worker name.`);

  const workerName = scoped.name ?? (env === undefined ? baseName : `${baseName}-${env}`);
  const migrations = scoped.migrations ?? config.migrations ?? [];
  const containers = scoped.containers ?? config.containers ?? [];
  return {
    workerName,
    migrationTag: migrations.at(-1)?.tag ?? null,
    hasContainers: containers.length > 0,
  };
}

/**
 * The `--config`/`-c` and `--env`/`-e` values of Wrangler arguments.
 *
 * @param {string[]} args
 * @returns {{ config: string | undefined, env: string | undefined }}
 */
export function parseConfigArgs(args) {
  /** @type {{ config: string | undefined, env: string | undefined }} */
  const parsed = { config: undefined, env: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.split("=", 2);
    const key = flag === "--config" || flag === "-c" ? "config" : flag === "--env" || flag === "-e" ? "env" : null;
    if (!key) continue;
    const value = inline ?? args[++index];
    if (!value) throw new Error(`${flag} needs a value.`);
    parsed[key] = value;
  }
  return parsed;
}
