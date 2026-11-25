import { z } from "zod";

/**
 * The value kinds that analytics properties may use. Each one is narrow on
 * purpose: a free-text property could carry docs text, a file path or a
 * token, so text values are short machine codes or a fixed list of words.
 */

/** A machine code such as an error code, a plan key or a limit name. */
export const codeToken = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);

/** A name that a client gives itself, such as the name of an MCP client. */
export const clientLabel = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N} ._()-]+$/u);

export const flag = z.boolean();
export const count = z.number().int().nonnegative();
export const durationSeconds = z.number().nonnegative();
export const amountCents = z.number().int().nonnegative();
export const isoTimestamp = z.iso.datetime({ offset: true });

/** An opaque ID from Doxa or its providers, such as a request ID. */
export const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** A route pattern with its parameter names, never a URL with values: `/projects/:projectId`. */
export const routePattern = z.string().regex(/^\/[A-Za-z0-9_/:.*{}-]{0,199}$/);

export const signInMethod = z.enum(["github", "google", "email"]);
export const planTier = z.enum(["free", "pro", "enterprise"]);
export const billingInterval = z.enum(["month", "year"]);
export const projectSource = z.enum(["repo", "starter", "empty"]);
/** The surface that started an action: the dashboard or a connected agent. */
export const actionVia = z.enum(["web", "mcp"]);
export const generationTrigger = z.enum(["manual", "doxabot", "merge"]);
export const generationRun = z.enum(["cold", "warm"]);
/** The end states of a generation job (`generation_job_status`). */
export const generationOutcome = z.enum(["succeeded", "failed", "cancelled", "stopped_credits"]);
export const publishVia = z.enum(["web", "mcp", "review"]);
export const pageSaveVia = z.enum(["editor", "agent", "mcp"]);
export const branchKind = z.enum(["main", "feature", "review"]);
/** The roles of `team_role`. */
export const teamRole = z.enum(["owner", "admin", "editor", "viewer"]);
export const invoiceKind = z.enum(["plan", "usage"]);
export const pageCountBand = z.enum(["1-10", "11-50", "51+"]);
