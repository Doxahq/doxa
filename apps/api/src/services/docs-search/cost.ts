import type { DocsSearchProvider } from "@doxahq/contracts/docs-search";

/**
 * Rates for the cost estimate, in US dollars. Typesense bills for the cluster,
 * so a site pays the share of the cluster's RAM that its index uses.
 * Measured on 2026-11-05: 2.4–3.8 bytes of RAM per indexed byte in separate
 * collections (`docs/current/docs-search.md`).
 */
export const DOCS_SEARCH_COST_RATES = {
  typesense: {
    clusterDollarsPerMonth: 86.4,
    usableRamBytes: 140 * 1024 * 1024,
    ramBytesPerIndexedByte: 3.8,
    dollarsPerResponseGb: 0.09,
  },
} as const;

export interface DocsSearchCostInput {
  provider: DocsSearchProvider;
  /** Indexed bytes of the live version. A replaced index stays for one hour. */
  indexedBytes: number;
  /**
   * Bytes of `answered` searches only: a cached answer costs the provider
   * nothing. It is the gateway's answer, which is a little smaller than the
   * provider's, so this is a low estimate.
   */
  providerResponseBytes: number;
  /** Rates of the current cluster. Defaults to the first cluster. */
  rates?: (typeof DOCS_SEARCH_COST_RATES)["typesense"];
}

export interface DocsSearchCostEstimate {
  storageDollars: number;
  bandwidthDollars: number;
  totalDollars: number;
}

/**
 * The estimated monthly cost of one site. Browser search has no cost per
 * search: its downloads come from our storage with no egress fee.
 */
export function estimateDocsSearchCost(
  input: DocsSearchCostInput,
): DocsSearchCostEstimate {
  if (input.provider === "minisearch") {
    return { storageDollars: 0, bandwidthDollars: 0, totalDollars: 0 };
  }
  const rates = input.rates ?? DOCS_SEARCH_COST_RATES.typesense;
  const ramShare =
    (input.indexedBytes * rates.ramBytesPerIndexedByte) / rates.usableRamBytes;
  const storageDollars = ramShare * rates.clusterDollarsPerMonth;
  const bandwidthDollars =
    (input.providerResponseBytes / 1024 ** 3) * rates.dollarsPerResponseGb;
  return {
    storageDollars,
    bandwidthDollars,
    totalDollars: storageDollars + bandwidthDollars,
  };
}
