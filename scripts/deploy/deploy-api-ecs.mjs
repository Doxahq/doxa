#!/usr/bin/env node
// Runs the API origin on one color of the blue/green ECS services that
// infra/terraform/production creates. The edge Worker sends traffic to one
// color; the other is idle. This script never changes the edge: it starts,
// updates or stops one color. scripts/deploy/deploy-api.mjs and scripts/deploy/release.mjs
// decide which color the edge uses.
//
//   node scripts/deploy/deploy-api-ecs.mjs --color green --image <repository_url>:<tag>   start an image on a color
//   node scripts/deploy/deploy-api-ecs.mjs --color blue --revision <task-definition-arn>  start a revision (rollback)
//   node scripts/deploy/deploy-api-ecs.mjs --retire blue                                  stop a color (0 tasks)
//
// An image deploy starts from the latest revision of the color's task family,
// so settings that Terraform changed ship with the next deploy. It carries
// the deploy variables (DOXA_RENDERER_RELEASE_ID) of the other color, which
// serves traffic. The color starts with as many tasks as the other one runs,
// within the task count that Terraform keeps in SSM.
//
// Options (defaults match the production stack):
//   --stack <name>        production: names the cluster, services, families and the SSM path
//   --container <name>    api
//   --region <region>     us-east-1, or AWS_REGION
//   --env NAME=VALUE      set a plain environment variable of the API container (repeatable)
//   --output <file>       write the result as JSON, for the release manifest
//   --no-wait             return after the service update, before the rollout ends
//
// It uses the AWS CLI with the credentials of the environment.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseTaskCount, scalableTargetId, startingTaskCount, taskCountParameterName } from "./lib/ecs-origin.mjs";
import { assertPinnedImage, carriedDeployVariables, nextRevisionWithImage, parseEnvironmentAssignments } from "./lib/ecs-task-definition.mjs";
import { colorResourceName, isOriginColor, otherColor } from "./lib/release/origin-colors.mjs";

const TASK_DEFINITION_ARN = /^arn:aws[\w-]*:ecs:[\w-]+:\d{12}:task-definition\/[\w-]+:\d+$/;

const options = parseArgs(process.argv.slice(2));
const aws = createAwsCli(options.region);
const baseName = `doxa-api-${options.stack}`;
const cluster = baseName;
const startedAt = Date.now();

if (options.retire) {
  retire(options.retire);
} else {
  start(options.color);
}
log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s.`);

/** @param {import("./lib/release/origin-colors.mjs").OriginColor} color */
function start(color) {
  const service = describeService(color);
  const live = describeService(otherColor(color));
  const targetRevision = options.revision ?? registerRevisionWithImage(color, live.taskDefinition);
  const taskCount = parseTaskCount(
    aws.json(["ssm", "get-parameter", "--name", taskCountParameterName(options.stack)]).Parameter.Value,
  );
  const desiredCount = startingTaskCount(taskCount, live.desiredCount);

  log(`Starting ${color} (${service.serviceName}) on ${revisionName(targetRevision)} with ${desiredCount} task(s); it was ${revisionName(service.taskDefinition)}.`);
  setTaskBounds(service.serviceName, taskCount.min, taskCount.max);
  aws.json([
    "ecs", "update-service", "--cluster", cluster, "--service", service.serviceName,
    "--task-definition", targetRevision, "--desired-count", String(desiredCount),
  ]);

  if (options.wait) {
    log("Waiting for the rollout. The new tasks must pass their health check, and cloudflared must join the tunnel.");
    aws.run(["ecs", "wait", "services-stable", "--cluster", cluster, "--services", service.serviceName]);
    assertRunning(color, targetRevision);
  }

  writeOutput({ color, revision: targetRevision, replacedRevision: service.taskDefinition, desiredCount, otherRevision: live.taskDefinition });
}

/** @param {import("./lib/release/origin-colors.mjs").OriginColor} color */
function retire(color) {
  const service = describeService(color);
  log(`Stopping ${color} (${service.serviceName}, ${revisionName(service.taskDefinition)}). Its tasks finish open requests first.`);
  setTaskBounds(service.serviceName, 0, 0);
  aws.json(["ecs", "update-service", "--cluster", cluster, "--service", service.serviceName, "--desired-count", "0"]);
  log(`Start it again with: node scripts/deploy/deploy-api-ecs.mjs --color ${color} --revision ${service.taskDefinition}`);
  writeOutput({ color, revision: service.taskDefinition, desiredCount: 0 });
}

function registerRevisionWithImage(color, liveRevision) {
  const family = colorResourceName(baseName, color);
  const described = aws.json(["ecs", "describe-task-definition", "--task-definition", family, "--include", "TAGS"]);
  const running = aws.json(["ecs", "describe-task-definition", "--task-definition", liveRevision]).taskDefinition;
  const carried = carriedDeployVariables(described.taskDefinition, running, options.container, options.environmentVariables);
  for (const name of Object.keys(carried)) log(`Keeping ${name} of the live revision ${revisionName(liveRevision)}.`);
  const input = attempt(() =>
    nextRevisionWithImage(described.taskDefinition, {
      containerName: options.container,
      image: options.image,
      environment: { ...carried, ...options.environmentVariables },
      tags: described.tags,
    }),
  );
  log(`Registering a revision of ${family} with ${options.image}.`);
  return aws.json(["ecs", "register-task-definition", "--cli-input-json", JSON.stringify(input)]).taskDefinition.taskDefinitionArn;
}

/** The ECS service of a color, as describe-services returns it. */
function describeService(color) {
  const name = colorResourceName(baseName, color);
  const { services, failures } = aws.json(["ecs", "describe-services", "--cluster", cluster, "--services", name]);
  const service = services?.[0];
  if (!service || service.status !== "ACTIVE") {
    fail(`Service ${name} is not active in cluster ${cluster}: ${JSON.stringify(failures ?? [])}. Run terraform apply for blue/green first.`);
  }
  return service;
}

function setTaskBounds(serviceName, min, max) {
  aws.run([
    "application-autoscaling", "register-scalable-target",
    "--service-namespace", "ecs", "--scalable-dimension", "ecs:service:DesiredCount",
    "--resource-id", scalableTargetId(cluster, serviceName),
    "--min-capacity", String(min), "--max-capacity", String(max),
  ]);
}

/** The circuit breaker rolls a failed deploy back, and the service is then stable on the old revision. */
function assertRunning(color, revision) {
  const service = describeService(color);
  if (service.taskDefinition !== revision) {
    fail(`The deploy of ${color} rolled back: it runs ${revisionName(service.taskDefinition)}. Read the logs with: aws logs tail /ecs/${baseName} --since 30m`);
  }
  if (service.runningCount < 1) fail(`${color} is stable on ${revisionName(revision)} but runs no task.`);
}

function writeOutput(result) {
  if (options.output) writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
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
  const parsed = {
    stack: "production",
    container: "api",
    region: process.env.AWS_REGION ?? "us-east-1",
    color: undefined,
    retire: undefined,
    image: undefined,
    revision: undefined,
    output: undefined,
    wait: true,
    environmentVariables: {},
  };
  const assignments = [];
  const valueFlags = new Map([
    ["--color", "color"],
    ["--retire", "retire"],
    ["--image", "image"],
    ["--revision", "revision"],
    ["--stack", "stack"],
    ["--container", "container"],
    ["--region", "region"],
    ["--output", "output"],
  ]);
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
      parsed[valueFlags.get(arg)] = value;
    } else {
      fail(`Unknown argument "${arg}".`);
    }
  }

  if (parsed.retire !== undefined) {
    if (!isOriginColor(parsed.retire)) fail("--retire needs blue or green.");
    if (parsed.color || parsed.image || parsed.revision || assignments.length > 0) fail("--retire takes no --color, --image, --revision or --env.");
    return parsed;
  }
  if (!isOriginColor(parsed.color)) fail("Pass --color blue|green with --image or --revision, or --retire blue|green.");
  if (Boolean(parsed.image) === Boolean(parsed.revision)) fail("Pass --image to deploy, or --revision to roll back, but not both.");
  if (parsed.revision && assignments.length > 0) fail("--env applies to --image deploys. A rollback restores the revision as it was.");
  if (parsed.image) attempt(() => assertPinnedImage(parsed.image));
  if (parsed.revision && !TASK_DEFINITION_ARN.test(parsed.revision)) {
    fail("--revision must be a task definition ARN, such as arn:aws:ecs:us-east-1:123456789012:task-definition/doxa-api-production:7.");
  }
  return { ...parsed, environmentVariables: attempt(() => parseEnvironmentAssignments(assignments)) };
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
