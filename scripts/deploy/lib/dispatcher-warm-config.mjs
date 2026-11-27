// Checks of the docs dispatcher's regional warm job config (M28): flags,
// queues, Durable Objects, the migration history and the cron. Used by
// validate-production-config.mjs. Queues, the migration and the cron take
// effect on the first deploy whatever the flags say (F2), so their exact
// shape is pinned here.

export const WARM_QUEUES = {
  publish: "doxa-docs-warm-publish",
  sweep: "doxa-docs-warm-sweep",
  dlq: "doxa-docs-warm-dlq",
};

export const WARM_CRON = "*/5 * * * *";

export const WARM_DURABLE_OBJECTS = {
  DOCS_WARM_LOCK: "DocsWarmLock",
  DOCS_WARM_ANCHOR: "DocsWarmAnchor",
  DOCS_REGIONAL_WARMER: "DocsRegionalWarmer",
  DOCS_WARM_CONTROL: "DocsWarmControl",
};

/**
 * Every migration ever deployed, in order. A Durable Object migration cannot
 * be undone, so the committed list may only grow at the end: never edit,
 * reorder or drop an entry here or in wrangler.json.
 */
export const DEPLOYED_DISPATCHER_MIGRATIONS = [
  {
    tag: "v1",
    new_sqlite_classes: [
      "DocsWarmLock",
      "DocsWarmAnchor",
      "DocsRegionalWarmer",
      "DocsWarmControl",
    ],
  },
];

const WARM_POOLS = [
  "us-west",
  "us-east",
  "eu-west",
  "eu-east",
  "asia-ne",
  "hong-kong",
  "singapore",
  "oceania",
];

const WARM_LIMITS = {
  DOXA_WARM_MAX_ACTIVE_WARMERS: 500,
  DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE: 500,
  DOXA_WARM_SWEEP_SITES_PER_TICK: 5_000,
  DOXA_WARM_MAX_PAGES: 2_000,
  DOXA_WARM_MAX_HOSTNAMES: 10,
  DOXA_WARM_SITE_FILLS_PER_HOUR: 1_000_000,
};

const CONSUMERS = [
  { queue: WARM_QUEUES.publish, max_concurrency: 5 },
  { queue: WARM_QUEUES.sweep, max_concurrency: 2 },
];

export function validateWarmJobConfig(config, label) {
  validateWarmFlags(config?.vars, label);
  validateWarmQueues(config?.queues, label);
  validateWarmDurableObjects(config, label);
  validateMigrationHistory(config?.migrations, label);
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons) || crons.length !== 1 || crons[0] !== WARM_CRON) {
    throw new Error(`${label} must set triggers.crons to ["${WARM_CRON}"].`);
  }
}

/** Committed defaults are off; a deploy turns the job on per site. */
export function validateWarmFlags(vars, label) {
  if (!["off", "on"].includes(vars?.DOXA_PROD_WARM_DEPLOY_SWEEP)) {
    throw new Error(`${label} must set DOXA_PROD_WARM_DEPLOY_SWEEP to off or on.`);
  }
  for (const [name, max] of Object.entries(WARM_LIMITS)) {
    const value = Number(vars?.[name]);
    if (typeof vars?.[name] !== "string" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${label} must set ${name} to a whole number between 1 and ${max}.`);
    }
  }
  const pools = String(vars?.DOXA_WARM_POOLS ?? "")
    .split(",")
    .map((pool) => pool.trim())
    .filter(Boolean);
  if (
    pools.length === 0 ||
    new Set(pools).size !== pools.length ||
    pools.some((pool) => !WARM_POOLS.includes(pool))
  ) {
    throw new Error(
      `${label} must set DOXA_WARM_POOLS to a comma list of distinct pools (${WARM_POOLS.join(", ")}).`,
    );
  }
}

export function validateWarmQueues(queues, label) {
  const producers = queues?.producers ?? [];
  for (const [binding, queue] of [
    ["DOCS_WARM_PUBLISH_QUEUE", WARM_QUEUES.publish],
    ["DOCS_WARM_SWEEP_QUEUE", WARM_QUEUES.sweep],
  ]) {
    if (!producers.some((item) => item?.binding === binding && item?.queue === queue)) {
      throw new Error(`${label} must bind ${binding} to the ${queue} queue.`);
    }
  }
  const consumers = queues?.consumers ?? [];
  if (consumers.length !== CONSUMERS.length) {
    throw new Error(`${label} must consume exactly the two warm queues.`);
  }
  for (const expected of CONSUMERS) {
    const consumer = consumers.find((item) => item?.queue === expected.queue);
    const actual = {
      max_batch_size: consumer?.max_batch_size,
      max_concurrency: consumer?.max_concurrency,
      max_retries: consumer?.max_retries,
      retry_delay: consumer?.retry_delay,
      dead_letter_queue: consumer?.dead_letter_queue,
    };
    const wanted = {
      max_batch_size: 1,
      max_concurrency: expected.max_concurrency,
      max_retries: 5,
      retry_delay: 60,
      dead_letter_queue: WARM_QUEUES.dlq,
    };
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(
        `${label} must consume ${expected.queue} with ${JSON.stringify(wanted)}.`,
      );
    }
  }
}

/**
 * The four classes are bound and declared by migrations. Wrangler refuses
 * Durable Object entries in `exports` next to `migrations`, so `exports`
 * keeps worker entrypoints only.
 */
export function validateWarmDurableObjects(config, label) {
  const bindings = config?.durable_objects?.bindings ?? [];
  for (const [name, className] of Object.entries(WARM_DURABLE_OBJECTS)) {
    if (
      !bindings.some(
        (item) => item?.name === name && item?.class_name === className && !item?.script_name,
      )
    ) {
      throw new Error(`${label} must bind ${name} to the ${className} Durable Object.`);
    }
  }
  for (const [name, entry] of Object.entries(config?.exports ?? {})) {
    if (entry?.type === "durable-object") {
      throw new Error(
        `${label} must not declare the Durable Object ${name} in exports; migrations declare it.`,
      );
    }
  }
}

/** Append-only: the deployed history is a prefix of the committed one. */
export function validateMigrationHistory(migrations, label) {
  if (!Array.isArray(migrations)) {
    throw new Error(`${label} must keep its Durable Object migrations.`);
  }
  DEPLOYED_DISPATCHER_MIGRATIONS.forEach((deployed, index) => {
    if (JSON.stringify(migrations[index]) !== JSON.stringify(deployed)) {
      throw new Error(
        `${label} must keep migration ${deployed.tag} unchanged at position ${index + 1}; migrations are append-only.`,
      );
    }
  });
  const tags = migrations.map((migration) => migration?.tag);
  if (new Set(tags).size !== tags.length || tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`${label} must give every migration a distinct tag.`);
  }
}
