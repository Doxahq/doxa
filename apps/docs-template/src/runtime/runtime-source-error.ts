export class RuntimeSourceError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "RuntimeSourceError";
  }
}
