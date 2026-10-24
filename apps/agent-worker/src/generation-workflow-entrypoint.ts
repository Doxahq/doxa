import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { GenerateJobMessage } from "@doxahq/contracts";
import type { Env } from "./index";
import {
  adaptGenerationWorkflowStep,
  GenerationNonRetryableError,
  GenerationWorkflowRunner,
} from "./generation-workflow-runtime";

export class GenerationWorkflow extends WorkflowEntrypoint<
  Env,
  GenerateJobMessage
> {
  override async run(
    event: Readonly<WorkflowEvent<GenerateJobMessage>>,
    step: WorkflowStep,
  ) {
    try {
      return await new GenerationWorkflowRunner(this.env).run(
        event,
        adaptGenerationWorkflowStep(
          step,
          (error) => new NonRetryableError(error.message),
        ),
      );
    } catch (error) {
      if (error instanceof GenerationNonRetryableError) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}
