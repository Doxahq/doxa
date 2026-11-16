/**
 * `@doxahq/billing/catalog`: the catalog, its keys and price display helpers.
 * Plain TypeScript with no runtime dependency, so the web app, the MCP
 * server and the docs runtime can import it.
 */
export * from "./keys";
export {
  CatalogError,
  MB,
  UNLIMITED,
  defineCatalog,
  featuresExcept,
  findCatalogProblems,
  isUnlimited,
  type ActionDefinition,
  type ActionPricing,
  type Catalog,
  type ChargeRule,
  type ChargeRules,
  type FlatPricing,
  type FreePricing,
  type LimitValue,
  type MeteredPricing,
  type OfferDefinition,
  type PaygDefinition,
  type PlanDefinition,
  type PriceDefinition,
  type TrialDefinition,
  type Unlimited,
  type UnsetPricing,
  type UsageDefinition,
  type UsagePriceDefinition,
} from "./define";
export { DOXA_CATALOG, type ActionOutcome, type DoxaCatalog, type OfferKey, type PriceKey, type UsagePriceKey } from "./doxa";
export {
  describeOffer,
  findOfferOfPrice,
  formatUsd,
  monthlyEquivalentCents,
  yearlySavingsPercent,
  type OfferPriceView,
  type OfferView,
} from "./display";
export { IMMUTABLE_PRICE_MESSAGE, buildCatalogLock, diffCatalogLock, type CatalogLock, type CatalogLockDiff } from "./lock";
