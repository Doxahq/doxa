import type { Catalog } from "../../catalog/define";
import { BillingNotConfiguredError } from "../../provider/errors";
import type {
  BillingProvider,
  CatalogSyncPlan,
  CatalogSyncResult,
  CheckoutLink,
  CheckoutResult,
  CustomerState,
  PortalLink,
  ProviderCapabilities,
  ProviderCustomerRef,
  ProviderEvent,
} from "../../provider/provider";
import type { Page } from "../../store/types";

export const NONE_PROVIDER = "none" as const;

/**
 * For self-hosted installs and local development without a payment provider
 * (spec 12.1). Capabilities are all false. Money operations throw
 * `BillingNotConfiguredError`, which the billing routes answer with
 * `billing_not_configured`. Every account gets `BILLING_DEFAULT_PLAN`
 * (`self_hosted`).
 */
export class NoneBillingProvider implements BillingProvider {
  readonly name = NONE_PROVIDER;
  readonly capabilities: ProviderCapabilities = {
    checkout: false,
    portal: false,
    invoices: false,
    refunds: false,
    usageReporting: false,
  };

  async ensureCustomer(): Promise<ProviderCustomerRef> {
    throw new BillingNotConfiguredError("ensureCustomer");
  }

  async createCheckout(): Promise<CheckoutLink> {
    throw new BillingNotConfiguredError("createCheckout");
  }

  async createPortalSession(): Promise<PortalLink> {
    throw new BillingNotConfiguredError("createPortalSession");
  }

  async listInvoices(): Promise<Page<never>> {
    return { items: [], nextCursor: null };
  }

  async fetchCustomerState(customer: ProviderCustomerRef): Promise<CustomerState> {
    return { customer, accountId: null, subscription: null, liveSubscriptions: [], firstPaidInvoiceAt: null };
  }

  async fetchCheckout(): Promise<CheckoutResult> {
    throw new BillingNotConfiguredError("fetchCheckout");
  }

  async expireCheckout(): Promise<void> {
    throw new BillingNotConfiguredError("expireCheckout");
  }

  async parseWebhook(): Promise<ProviderEvent> {
    throw new BillingNotConfiguredError("parseWebhook");
  }

  async listEventsSince(): Promise<Page<ProviderEvent>> {
    return { items: [], nextCursor: null };
  }

  async planCatalogSync(_catalog: Catalog): Promise<CatalogSyncPlan> {
    return { provider: NONE_PROVIDER, actions: [] };
  }

  async applyCatalogSync(): Promise<CatalogSyncResult> {
    return { applied: 0 };
  }
}
