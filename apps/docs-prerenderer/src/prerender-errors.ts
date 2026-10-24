export class PrerenderTaskObsoleteError extends Error {
  constructor(message = "The pre-render task is no longer active.") {
    super(message);
    this.name = "PrerenderTaskObsoleteError";
  }
}

export class PrerenderPermanentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrerenderPermanentError";
  }
}
