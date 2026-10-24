/**
 * Measures one step of a request for the Server-Timing header. Services take
 * it as an option, so they do not depend on the HTTP layer.
 */
export type MeasureStep = <T>(name: string, step: () => Promise<T>) => Promise<T>;

/** Runs the step and measures nothing. */
export const unmeasured: MeasureStep = (_name, step) => step();
