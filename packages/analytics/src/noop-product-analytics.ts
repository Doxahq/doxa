import type { ProductAnalytics } from "./product-analytics";

/** Product analytics when no provider is set, such as local development or self-hosting. */
export const NOOP_PRODUCT_ANALYTICS: ProductAnalytics = Object.freeze({
  capture: () => {},
  captureWhenReady: () => {},
  identify: () => {},
  describeGroup: () => {},
  captureException: () => {},
  flush: async () => {},
});
