import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEPLOYED_DISPATCHER_MIGRATIONS,
  validateMigrationHistory,
  validateWarmDurableObjects,
  validateWarmFlags,
  validateWarmJobConfig,
  validateWarmQueues,
} from "./lib/dispatcher-warm-config.mjs";

const dispatcherConfigPath = path.join(
  import.meta.dirname,
  "..",
  "apps",
  "docs-dispatcher",
  "wrangler.json",
);

function readDispatcherConfig() {
  return JSON.parse(readFileSync(dispatcherConfigPath, "utf8"));
}

test("keeps the warm job off by default with the documented limits", () => {
  const { vars } = readDispatcherConfig();
  assert.equal(vars.DOXA_PROD_WARM_MODE, "off");
  assert.equal(vars.DOXA_PROD_WARM_DEPLOY_SWEEP, "off");
  assert.equal(vars.DOXA_WARM_MAX_ACTIVE_WARMERS, "24");
  assert.equal(vars.DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE, "4");
  assert.equal(vars.DOXA_WARM_SWEEP_SITES_PER_TICK, "200");
  assert.equal(vars.DOXA_WARM_MAX_PAGES, "500");
  assert.equal(vars.DOXA_WARM_MAX_HOSTNAMES, "3");
  assert.equal(vars.DOXA_WARM_SITE_FILLS_PER_HOUR, "20000");
  assert.equal(
    vars.DOXA_WARM_POOLS,
    "us-east,eu-west,us-west,asia-ne,singapore,hong-kong,eu-east,oceania",
  );
});

test("accepts the committed dispatcher warm config", () => {
  validateWarmJobConfig(readDispatcherConfig(), "x");
});

test("pins the queues, the cron and the four Durable Objects", () => {
  const config = readDispatcherConfig();
  assert.deepEqual(config.triggers, { crons: ["*/5 * * * *"] });
  assert.deepEqual(
    config.durable_objects.bindings.map((item) => item.class_name),
    ["DocsWarmLock", "DocsWarmAnchor", "DocsRegionalWarmer", "DocsWarmControl"],
  );
  assert.deepEqual(config.migrations, DEPLOYED_DISPATCHER_MIGRATIONS);
});

test("rejects invalid warm flags", () => {
  const { vars } = readDispatcherConfig();
  for (const [change, message] of [
    [{ DOXA_PROD_WARM_DEPLOY_SWEEP: "all" }, /DOXA_PROD_WARM_DEPLOY_SWEEP to off or on/],
    [{ DOXA_PROD_WARM_DEPLOY_SWEEP: undefined }, /DOXA_PROD_WARM_DEPLOY_SWEEP/],
    [{ DOXA_WARM_MAX_ACTIVE_WARMERS: "0" }, /DOXA_WARM_MAX_ACTIVE_WARMERS/],
    [{ DOXA_WARM_MAX_ACTIVE_WARMERS: "24.5" }, /DOXA_WARM_MAX_ACTIVE_WARMERS/],
    [{ DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE: "0" }, /DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE/],
    [{ DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE: undefined }, /DOXA_WARM_MAX_ACTIVE_WARMERS_PER_SITE/],
    [{ DOXA_WARM_MAX_PAGES: "5000" }, /DOXA_WARM_MAX_PAGES/],
    [{ DOXA_WARM_MAX_HOSTNAMES: "11" }, /DOXA_WARM_MAX_HOSTNAMES/],
    [{ DOXA_WARM_SWEEP_SITES_PER_TICK: 200 }, /DOXA_WARM_SWEEP_SITES_PER_TICK/],
    [{ DOXA_WARM_SITE_FILLS_PER_HOUR: "" }, /DOXA_WARM_SITE_FILLS_PER_HOUR/],
    [{ DOXA_WARM_POOLS: "us-east,mars" }, /DOXA_WARM_POOLS/],
    [{ DOXA_WARM_POOLS: "us-east,us-east" }, /DOXA_WARM_POOLS/],
    [{ DOXA_WARM_POOLS: "" }, /DOXA_WARM_POOLS/],
  ]) {
    assert.throws(() => validateWarmFlags({ ...vars, ...change }, "x"), message);
  }
  validateWarmFlags({ ...vars, DOXA_PROD_WARM_DEPLOY_SWEEP: "on", DOXA_WARM_POOLS: "eu-west" }, "x");
});

test("rejects queue settings other than the exact ones", () => {
  const { queues } = readDispatcherConfig();
  const consumer = (index, change) => ({
    ...queues,
    consumers: queues.consumers.map((item, i) => (i === index ? { ...item, ...change } : item)),
  });
  for (const changed of [
    consumer(0, { max_batch_size: 10 }),
    consumer(0, { max_concurrency: 50 }),
    consumer(1, { max_concurrency: 5 }),
    consumer(1, { max_retries: 3 }),
    consumer(0, { retry_delay: 5 }),
    consumer(1, { dead_letter_queue: undefined }),
    { ...queues, consumers: queues.consumers.slice(0, 1) },
    { ...queues, producers: queues.producers.slice(1) },
    { ...queues, producers: [{ binding: "DOCS_WARM_PUBLISH_QUEUE", queue: "other" }, queues.producers[1]] },
  ]) {
    assert.throws(() => validateWarmQueues(changed, "x"));
  }
});

test("rejects a missing cron or a changed schedule", () => {
  const config = readDispatcherConfig();
  assert.throws(() => validateWarmJobConfig({ ...config, triggers: { crons: [] } }, "x"), /triggers.crons/);
  assert.throws(
    () => validateWarmJobConfig({ ...config, triggers: { crons: ["* * * * *"] } }, "x"),
    /triggers.crons/,
  );
});

test("requires the Durable Object bindings and keeps them out of exports", () => {
  const config = readDispatcherConfig();
  assert.throws(
    () =>
      validateWarmDurableObjects(
        { ...config, durable_objects: { bindings: config.durable_objects.bindings.slice(1) } },
        "x",
      ),
    /DOCS_WARM_LOCK/,
  );
  assert.throws(
    () =>
      validateWarmDurableObjects(
        {
          ...config,
          exports: { ...config.exports, DocsWarmLock: { type: "durable-object", storage: "sqlite" } },
        },
        "x",
      ),
    /must not declare the Durable Object DocsWarmLock in exports/,
  );
});

test("treats Durable Object migrations as append-only", () => {
  const v1 = DEPLOYED_DISPATCHER_MIGRATIONS[0];
  validateMigrationHistory([v1], "x");
  validateMigrationHistory([v1, { tag: "v2", new_sqlite_classes: ["DocsWarmNext"] }], "x");
  for (const [migrations, message] of [
    [[], /keep migration v1/],
    [[{ ...v1, new_sqlite_classes: v1.new_sqlite_classes.slice(1) }], /keep migration v1/],
    [[{ ...v1, tag: "v0" }], /keep migration v1/],
    [[{ tag: "v0", new_sqlite_classes: ["X"] }, v1], /keep migration v1/],
    [[v1, { tag: "v1", deleted_classes: ["DocsWarmLock"] }], /distinct tag/],
    [undefined, /keep its Durable Object migrations/],
  ]) {
    assert.throws(() => validateMigrationHistory(migrations, "x"), message);
  }
});
