import type { NormalizedChangeProposalEvent } from "@doxahq/contracts";
import type { DoxabotAutomationContext } from "../../repositories/doxabot-settings";
import type { ChangeProposalLifecycleState } from "../../repositories/change-proposals";

export interface ChangeProposalSnapshot {
  externalId: string;
  number: number;
  draft: boolean;
  state: ChangeProposalLifecycleState;
  baseRef: string;
  baseRevision: string;
  headRevision: string;
  sourceUpdatedAt: Date;
  /** GitHub's `size` of the base repository, in KB, when GitHub sent it. */
  repositorySizeKb?: number;
}

export interface ChangeProposalStateResolver {
  getCurrent(input: {
    context: DoxabotAutomationContext;
    event: NormalizedChangeProposalEvent;
  }): Promise<ChangeProposalSnapshot>;
}
