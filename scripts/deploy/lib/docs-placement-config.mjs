const DATABASE_REGION = "aws:us-east-1";
const RESOLVER_SERVICE = "doxa-docs-resolver-production";

/** Validate the production routing boundary, not just the existence of a flag. */
export function validateDocsPlacementConfigs({
  api,
  resolver,
  dispatcher,
  runtime,
  shared,
  web,
}) {
  const apiProduction = api.env?.production;
  const resolverProduction = resolver.env?.production;
  const runtimeProduction = runtime.env?.production;
  requireDatabasePlacement(apiProduction, "API");
  requireDatabasePlacement(resolverProduction, "Docs resolver");

  if (
    resolver.name !== "doxa-docs-resolver" ||
    resolver.main !== "src/docs-resolver.ts"
  ) {
    throw new Error(
      "Docs resolver must use its dedicated default fetch entrypoint.",
    );
  }
  for (const config of [resolver, resolverProduction]) {
    if (
      config.workers_dev !== false ||
      config.preview_urls !== false ||
      config.routes?.length ||
      config.route
    ) {
      throw new Error(
        "Docs resolver must remain private: disable workers_dev, preview_urls, and public routes.",
      );
    }
  }

  const freshId = apiProduction.hyperdrive?.find(
    (item) => item.binding === "HYPERDRIVE_CACHE_DISABLED",
  )?.id;
  const resolverFreshId = resolverProduction.hyperdrive?.find(
    (item) => item.binding === "HYPERDRIVE_CACHE_DISABLED",
  )?.id;
  if (
    !freshId ||
    resolverFreshId !== freshId ||
    resolverProduction.vars?.DATABASE_URL
  ) {
    throw new Error(
      "Docs resolver must use the API's fresh Hyperdrive binding without a direct DATABASE_URL override.",
    );
  }
  for (const variable of ["DOCS_BASE_DOMAIN", "DOCS_PREVIEW_GATE_ENABLED"]) {
    const apiValue = apiProduction.vars?.[variable];
    const resolverValue = resolverProduction.vars?.[variable];
    const matches =
      variable === "DOCS_PREVIEW_GATE_ENABLED"
        ? (apiValue === "true") === (resolverValue === "true")
        : Boolean(apiValue) && apiValue === resolverValue;
    if (!matches)
      throw new Error(`API and docs resolver must agree on ${variable}.`);
  }

  requireResolverBinding(dispatcher, "Docs dispatcher");
  requireResolverBinding(runtimeProduction, "Docs runtime");
  for (const [name, config] of Object.entries({
    dispatcher,
    runtime,
    shared,
    web,
  })) {
    for (const placement of [
      config.placement,
      config.env?.production?.placement,
    ]) {
      if (
        placement &&
        !(placement.mode === "off" && Object.keys(placement).length === 1)
      ) {
        throw new Error(`${name} must retain edge placement.`);
      }
    }
  }
}

function requireDatabasePlacement(config, name) {
  if (
    config?.placement?.region !== DATABASE_REGION ||
    config.placement.mode ||
    config.placement.host ||
    config.placement.hostname
  ) {
    throw new Error(`${name} must use placement.region = ${DATABASE_REGION}.`);
  }
}

export function requireResolverBinding(config, name) {
  const binding = config?.services?.find(
    (item) => item.binding === "DOCS_RESOLVER",
  );
  if (!binding || binding.service !== RESOLVER_SERVICE || binding.entrypoint) {
    throw new Error(
      `${name} must bind DOCS_RESOLVER to the default fetch handler of ${RESOLVER_SERVICE}.`,
    );
  }
}
