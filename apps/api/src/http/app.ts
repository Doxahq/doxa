import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";

export type ApiBindings = {
  Bindings: Env;
};

export type ApiContext = Context<ApiBindings>;
export type ApiApp = Hono<ApiBindings>;

export function createApiRouter(): ApiApp {
  return new Hono<ApiBindings>({ strict: false });
}
