import { docsPublicationSummarySchema } from "@doxahq/contracts/docs-branches";
import type { DocsMutationTransaction } from "../../src/repositories/docs-cache-invalidations";
import type {
  DocsPublicationStore,
  RecordPublicationInput,
} from "../../src/repositories/docs-publications";

export class InMemoryDocsPublicationStore implements DocsPublicationStore {
  readonly records: Array<{ id: string; input: RecordPublicationInput }> = [];

  async record(
    _tx: DocsMutationTransaction,
    input: RecordPublicationInput,
  ): Promise<string> {
    docsPublicationSummarySchema.parse(input.summary);
    const id = crypto.randomUUID();
    this.records.push({ id, input });
    return id;
  }
}
