// Pure parts of scripts/deploy/deploy-api-ecs.mjs: the task count of a color and
// the IDs that Application Auto Scaling uses. The script runs the AWS CLI;
// the tests check these.

/**
 * The SSM parameter where Terraform keeps the task count of the live color,
 * as JSON {"min":1,"max":1}. The deploy owns the bounds of each color's
 * scalable target (0 while idle), so Terraform cannot set them directly.
 */
export function taskCountParameterName(environment) {
  return `/doxa/api/${environment}/deploy/task-count`;
}

/**
 * @typedef {{ min: number, max: number }} TaskCount
 *
 * @param {string} text the parameter value
 * @returns {TaskCount}
 */
export function parseTaskCount(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The task count parameter is not JSON: ${text}`);
  }
  const { min, max } = value ?? {};
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(`The task count parameter must be {"min":N,"max":M} with 1 <= N <= M. It is ${text}.`);
  }
  return { min, max };
}

/**
 * The task count that a color starts with: at least the minimum, and as many
 * as the live color runs, so the new color takes the current load.
 *
 * @param {TaskCount} taskCount
 * @param {number} liveDesiredCount
 */
export function startingTaskCount(taskCount, liveDesiredCount) {
  return Math.min(taskCount.max, Math.max(taskCount.min, liveDesiredCount));
}

/** The resource ID of an ECS service in Application Auto Scaling. */
export function scalableTargetId(cluster, service) {
  return `service/${cluster}/${service}`;
}
