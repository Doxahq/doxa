import assert from "node:assert/strict";
import test from "node:test";
import { validateDocsPlacementConfigs } from "../lib/docs-placement-config.mjs";

function configs() {
  const placement = { region: "aws:us-east-1" };
  const hyperdrive = [{ binding: "HYPERDRIVE_CACHE_DISABLED", id: "fresh-db" }];
  const vars = { DOCS_BASE_DOMAIN: "doxa.page" };
  const services = [
    { binding: "DOCS_RESOLVER", service: "doxa-docs-resolver-production" },
  ];
  return structuredClone({
    api: { env: { production: { placement, hyperdrive, vars } } },
    resolver: {
      name: "doxa-docs-resolver",
      main: "src/docs-resolver.ts",
      workers_dev: false,
      preview_urls: false,
      env: {
        production: {
          placement,
          hyperdrive: structuredClone(hyperdrive),
          vars: { ...vars },
          workers_dev: false,
          preview_urls: false,
        },
      },
    },
    dispatcher: { services },
    runtime: { env: { production: { services: structuredClone(services) } } },
    shared: {},
    web: {},
  });
}

test("accepts private region-targeted database workers with edge consumers", () => {
  assert.doesNotThrow(() => validateDocsPlacementConfigs(configs()));
});

for (const target of ["api", "resolver"]) {
  test(`rejects misplaced ${target}`, () => {
    const value = configs();
    value[target].env.production.placement = { region: "aws:ap-southeast-2" };
    assert.throws(() => validateDocsPlacementConfigs(value), /placement/);
  });
}

for (const key of ["workers_dev", "preview_urls", "routes"]) {
  test(`rejects resolver exposure through ${key}`, () => {
    const value = configs();
    value.resolver.env.production[key] =
      key === "routes"
        ? [{ pattern: "resolver.example.com", custom_domain: true }]
        : true;
    assert.throws(() => validateDocsPlacementConfigs(value), /private/);
  });
}

test("rejects a resolver without the API's fresh database binding", () => {
  const value = configs();
  value.resolver.env.production.hyperdrive[0].id = "cached-db";
  assert.throws(() => validateDocsPlacementConfigs(value), /Hyperdrive/);
});

test("rejects drift in hostname and preview policy configuration", () => {
  const value = configs();
  value.resolver.env.production.vars.DOCS_BASE_DOMAIN = "wrong.example";
  assert.throws(() => validateDocsPlacementConfigs(value), /DOCS_BASE_DOMAIN/);
  value.resolver.env.production.vars.DOCS_BASE_DOMAIN = "doxa.page";
  value.resolver.env.production.vars.DOCS_PREVIEW_GATE_ENABLED = "true";
  assert.throws(
    () => validateDocsPlacementConfigs(value),
    /DOCS_PREVIEW_GATE_ENABLED/,
  );
});

for (const target of ["dispatcher", "runtime"]) {
  test(`rejects named-entrypoint resolver binding on ${target}`, () => {
    const value = configs();
    const consumer =
      target === "runtime" ? value.runtime.env.production : value.dispatcher;
    consumer.services[0].entrypoint = "InternalApi";
    assert.throws(() => validateDocsPlacementConfigs(value), /default fetch/);
  });
  test(`rejects missing resolver binding on ${target}`, () => {
    const value = configs();
    const consumer =
      target === "runtime" ? value.runtime.env.production : value.dispatcher;
    consumer.services = [];
    assert.throws(() => validateDocsPlacementConfigs(value), /DOCS_RESOLVER/);
  });
}

for (const target of ["dispatcher", "runtime", "shared", "web"]) {
  test(`rejects moving edge worker ${target} near the database`, () => {
    const value = configs();
    value[target].placement = { region: "aws:us-east-1" };
    assert.throws(() => validateDocsPlacementConfigs(value), /edge/);
  });
}
