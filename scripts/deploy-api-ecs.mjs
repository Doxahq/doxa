#!/usr/bin/env node
// Deploys an API image to the ECS service that infra/terraform/production
// creates. It starts from the latest revision of the task definition family,
// so settings that Terraform changed ship with the next deploy.
//
//   node scripts/deploy-api-ecs.mjs --image <repository_url>:<git-sha>
//   node scripts/deploy-api-ecs.mjs --revision <task-definition-arn>   rollback
//
// Options (defaults match the production stack):
//   --cluster <name>    doxa-api-production
//   --service <name>    doxa-api-production
//   --family <name>     doxa-api-production
//   --container <name>  api
//   --region <region>   us-east-1, or AWS_REGION
//   --env NAME=VALUE    set a plain environment variable of the API container (repeatable)
//   --no-wait           return after the service update, before the rollout ends
//
// It uses the AWS CLI with the credentials of the environment.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { assertPinnedImage, nextRevisionWithImage, parseEnvironmentAssignments } from "./lib/ecs-task-definition.mjs";

const DEFAULTS = Object.freeze({
  cluster: "doxa-api-production",
  service: "doxa-api-production",
  family: "doxa-api-production",
  container: "api",
  region: process.env.AWS_REGION ?? "us-east-1",
});

const TASK_DEFINITION_ARN = /^arn:aws[\w-]*:ecs:[\w-]+:\d{12}:task-definition\/[\w-]+:\d+$/;

const options = parseArgs(process.argv.slice(2));
const aws = createAwsCli(options.region);

const startedAt = Date.now();
const previousRevision = currentServiceRevision();
const targetRevision = options.revision ?? registerRevisionWithImage(options.image);

log(`Updating ${options.service} from ${revisionName(previousRevision)} to ${revisionName(targetRevision)}.`);
aws.json(["ecs", "update-service", "--cluster", options.cluster, "--service", options.service, "--task-definition", targetRevision]);

if (options.wait) {
  log("Waiting for the rollout. The new task must pass its health check before the old one stops.");
  aws.run(["ecs", "wait", "services-stable", "--cluster", options.cluster, "--services", options.service]);
  assertRolledOut(targetRevision);
}

log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
log(`Roll back with: node scripts/deploy-api-ecs.mjs --revision ${previousRevision}`);

function registerRevisionWithImage(image) {
  const described = aws.json(["ecs", "describe-task-definition", "--task-definition", options.family, "--include", "TAGS"]);
  const input = attempt(() =>
    nextRevisionWithImage(described.taskDefinition, {
      containerName: options.container,
      image,
      environment: options.environment,
      tags: described.tags,
    }),
  );
  log(`Registering a revision of ${options.family} with ${image}.`);
  const registered = aws.json(["ecs", "register-task-definition", "--cli-input-json", JSON.stringify(input)]);
  return registered.taskDefinition.taskDefinitionArn;
}

function currentServiceRevision() {
  const { services, failures } = aws.json(["ecs", "describe-services", "--cluster", options.cluster, "--services", options.service]);
  const service = services?.[0];
  if (!service || service.status !== "ACTIVE") {
    fail(`Service ${options.service} is not active in cluster ${options.cluster}: ${JSON.stringify(failures ?? [])}`);
  }
  return service.taskDefinition;
}

/** The circuit breaker rolls a failed deploy back, and the service is then stable on the old revision. */
function assertRolledOut(revision) {
  const running = currentServiceRevision();
  if (running !== revision) {
    fail(`The deploy rolled back: the service runs ${revisionName(running)}. Read the logs with: aws logs tail /ecs/${options.service} --since 30m`);
  }
}

function createAwsCli(region) {
  const run = (args, stdio) => {
    const result = spawnSync("aws", [...args, "--region", region], { encoding: "utf8", stdio });
    if (result.error) fail(`Cannot run the AWS CLI: ${result.error.message}`);
    if (result.status !== 0) fail(`aws ${args.slice(0, 2).join(" ")} failed:\n${result.stderr ?? ""}`);
    return result.stdout;
  };
  return {
    json: (args) => JSON.parse(run([...args, "--output", "json"], ["ignore", "pipe", "pipe"])),
    run: (args) => run(args, ["ignore", "inherit", "pipe"]),
  };
}

function revisionName(arn) {
  return arn.split("/").pop();
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS, image: undefined, revision: undefined, wait: true, environment: {} };
  const assignments = [];
  const valueFlags = new Set(["--image", "--revision", "--cluster", "--service", "--family", "--container", "--region"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--no-wait") {
      parsed.wait = false;
    } else if (arg === "--env") {
      const value = args[++i];
      if (!value) fail("--env needs NAME=VALUE.");
      assignments.push(value);
    } else if (valueFlags.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value.`);
      parsed[arg.slice(2)] = value;
    } else {
      fail(`Unknown argument "${arg}".`);
    }
  }
  if (Boolean(parsed.image) === Boolean(parsed.revision)) fail("Pass --image to deploy, or --revision to roll back, but not both.");
  parsed.environment = attempt(() => parseEnvironmentAssignments(assignments));
  if (parsed.revision && assignments.length > 0) fail("--env applies to --image deploys. A rollback restores the revision as it was.");
  if (parsed.image) attempt(() => assertPinnedImage(parsed.image));
  if (parsed.revision && !TASK_DEFINITION_ARN.test(parsed.revision)) {
    fail(`--revision must be a task definition ARN, such as arn:aws:ecs:us-east-1:123456789012:task-definition/${parsed.family}:7.`);
  }
  return parsed;
}

/** Runs a check that throws, and exits with its message instead of a stack trace. */
function attempt(check) {
  try {
    return check();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function log(message) {
  console.log(`[deploy-api-ecs] ${message}`);
}

function fail(message) {
  console.error(`[deploy-api-ecs] ${message}`);
  process.exit(1);
}
