// Builds the next revision of an ECS task definition from the current one.
// `aws ecs describe-task-definition` returns read-only fields (arn, revision,
// status, registeredAt...) that `register-task-definition` rejects, so the
// next revision keeps only the fields that registration accepts.

/** Fields of a described task definition that RegisterTaskDefinition accepts. */
export const REGISTERABLE_FIELDS = Object.freeze([
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "containerDefinitions",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "pidMode",
  "ipcMode",
  "proxyConfiguration",
  "inferenceAccelerators",
  "ephemeralStorage",
  "runtimePlatform",
  "enableFaultInjection",
]);

const IMAGE_PATTERN = /^[^\s:@]+(?::[0-9]+)?\/[^\s:@]+(?::[\w][\w.-]{0,127}|@sha256:[a-f0-9]{64})$/;

/**
 * @typedef {{ name: string, value: string }} EnvironmentVariable
 * @typedef {{ name: string, image: string, environment?: EnvironmentVariable[] } & Record<string, unknown>} ContainerDefinition
 * @typedef {{ family: string, containerDefinitions: ContainerDefinition[] } & Record<string, unknown>} TaskDefinition
 * @typedef {{ key: string, value: string }} Tag
 */

/**
 * The registration input for the next revision: the current task definition
 * with a new image in one container, and optionally new values for some of
 * its environment variables. Every other container and setting stays the
 * same, so a deploy changes only what it names.
 *
 * @param {TaskDefinition} taskDefinition as returned by describe-task-definition
 * @param {{ containerName: string, image: string, environment?: Record<string, string>, tags?: Tag[] }} change
 * @returns {Record<string, unknown>}
 */
export function nextRevisionWithImage(taskDefinition, { containerName, image, environment = {}, tags = [] }) {
  assertPinnedImage(image);

  const containers = taskDefinition.containerDefinitions ?? [];
  if (!containers.some((container) => container.name === containerName)) {
    const names = containers.map((container) => container.name).join(", ") || "none";
    throw new Error(`Task definition ${taskDefinition.family} has no container "${containerName}" (containers: ${names}).`);
  }

  const registerable = Object.fromEntries(
    REGISTERABLE_FIELDS.filter((field) => taskDefinition[field] !== undefined).map((field) => [field, taskDefinition[field]]),
  );

  return {
    ...registerable,
    containerDefinitions: containers.map((container) =>
      container.name === containerName
        ? { ...container, image, environment: withEnvironment(container.environment ?? [], environment) }
        : container,
    ),
    ...(tags.length > 0 ? { tags } : {}),
  };
}

/**
 * Rejects images without a tag or digest, and the `latest` tag: a deploy must
 * name one exact image, so a rollback can name it again.
 *
 * @param {string} image
 */
export function assertPinnedImage(image) {
  if (!IMAGE_PATTERN.test(image)) {
    throw new Error(`Image "${image}" must be <registry>/<repository>:<tag> or <registry>/<repository>@sha256:<digest>.`);
  }
  if (image.endsWith(":latest")) {
    throw new Error(`Image "${image}" uses the latest tag. Deploy a commit tag or a digest.`);
  }
}

/**
 * The variables with `overrides` applied: a named variable gets the new value,
 * a new one is added. The result is sorted by name, as Terraform writes it.
 *
 * @param {EnvironmentVariable[]} current
 * @param {Record<string, string>} overrides
 * @returns {EnvironmentVariable[]}
 */
export function withEnvironment(current, overrides) {
  const byName = new Map(current.map((variable) => [variable.name, variable.value]));
  for (const [name, value] of Object.entries(overrides)) byName.set(name, value);
  return [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
}

const ENV_ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/s;

/**
 * Parses `NAME=VALUE` arguments. Secrets do not belong here: they come from
 * SSM through the task definition's `secrets`.
 *
 * @param {string[]} assignments
 * @returns {Record<string, string>}
 */
export function parseEnvironmentAssignments(assignments) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const assignment of assignments) {
    const match = ENV_ASSIGNMENT.exec(assignment);
    if (!match) throw new Error(`"${assignment}" must be NAME=VALUE, with NAME in UPPER_SNAKE_CASE.`);
    environment[match[1]] = match[2];
  }
  return environment;
}
