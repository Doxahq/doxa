/** Stops a workflow step without a retry. The step adapter turns it into the Workflows `NonRetryableError`. */
export class GenerationNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationNonRetryableError";
  }
}
