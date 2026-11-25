import { z } from "zod";

/**
 * Where an event is captured. Server events count users and money, so only
 * the API sends them and ad blockers cannot change them. Browser events cover
 * clicks and dialogs that the server never sees.
 */
export type ProductEventSource = "server" | "browser";

export interface ProductEventDefinition<
  Source extends ProductEventSource = ProductEventSource,
  Shape extends z.ZodRawShape = z.ZodRawShape,
> {
  readonly source: Source;
  /**
   * The only properties that the event may carry. Parsing drops every other
   * key, so a property that is not listed here never leaves Doxa.
   */
  readonly properties: z.ZodObject<Shape>;
}

export function serverEvent<Shape extends z.ZodRawShape>(shape: Shape): ProductEventDefinition<"server", Shape> {
  return { source: "server", properties: z.object(shape) };
}

export function browserEvent<Shape extends z.ZodRawShape>(shape: Shape): ProductEventDefinition<"browser", Shape> {
  return { source: "browser", properties: z.object(shape) };
}
