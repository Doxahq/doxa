import type { DoxabotInstructions } from "@doxahq/contracts";

import type { ProjectAnalysis } from "../../types";

/** Which audience each reader that the owner can choose means for the pipeline. */
export const READER_AUDIENCE: Readonly<
  Record<DoxabotInstructions["audience"]["reader"], NonNullable<ProjectAnalysis["documentationIntent"]>["audience"]>
> = {
  developers: "consumer",
  end_users: "consumer",
  mixed: "mixed",
  internal: "maintainer",
};
