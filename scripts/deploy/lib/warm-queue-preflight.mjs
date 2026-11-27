// F2: the dispatcher's queue bindings take effect on its first deploy, and
// `wrangler deploy` fails when a queue is missing. The renderer deploy puts
// the shared renderer and the package live before the dispatcher, so a late
// failure leaves a half-deployed release. This read-only check runs first.

/** Every queue the dispatcher config names: producers, consumers, DLQs. */
export function listConfiguredQueues(config) {
  const names = new Set();
  for (const producer of config?.queues?.producers ?? []) {
    if (producer?.queue) names.add(producer.queue);
  }
  for (const consumer of config?.queues?.consumers ?? []) {
    if (consumer?.queue) names.add(consumer.queue);
    if (consumer?.dead_letter_queue) names.add(consumer.dead_letter_queue);
  }
  return [...names].sort();
}

/**
 * The outcome of `wrangler queues info <name>`: `exists`, `missing`, or
 * `unknown` when the output names neither (for example an auth error).
 */
export function classifyQueueInfo({ status, output }) {
  if (status === 0) return "exists";
  if (/does not exist|not found|could not find|no queue|\[code: 11000\]/i.test(output)) {
    return "missing";
  }
  return "unknown";
}

/**
 * Checks every queue with `inspect(name)` (read-only). Returns the missing
 * and unchecked names; the caller fails before any deploy step.
 */
export function findQueueProblems(config, inspect) {
  const missing = [];
  const unchecked = [];
  for (const name of listConfiguredQueues(config)) {
    const outcome = classifyQueueInfo(inspect(name));
    if (outcome === "missing") missing.push(name);
    if (outcome === "unknown") unchecked.push(name);
  }
  return { missing, unchecked };
}

/** The message that stops a deploy, with the commands that fix it. */
export function describeQueueProblems({ missing, unchecked }) {
  const lines = [];
  if (missing.length > 0) {
    lines.push(
      `The dispatcher binds queues that do not exist: ${missing.join(", ")}.`,
      "Create them first (the dead-letter queue before the others), from doxa-ops with approval:",
      // A DLQ must exist before a consumer names it.
      ...[...missing]
        .sort((left, right) => Number(right.endsWith("-dlq")) - Number(left.endsWith("-dlq")))
        .map((name) => `  pnpm exec wrangler queues create ${name}`),
    );
  }
  if (unchecked.length > 0) {
    lines.push(
      `Could not check the queues ${unchecked.join(", ")} (wrangler queues info failed). Fix access and retry.`,
    );
  }
  return lines.join("\n");
}
