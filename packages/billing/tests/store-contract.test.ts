import { MemoryBillingStore, describeBillingStoreContract } from "../src/testing";

describeBillingStoreContract("memory", () => new MemoryBillingStore());
