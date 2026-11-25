import { z } from "zod";
import {
  billingInterval,
  codeToken,
  count,
  flag,
  isoTimestamp,
  opaqueId,
  pageCountBand,
  projectSource,
  routePattern,
  signInMethod,
} from "./property-schemas";

/**
 * Properties of a person. The person's ID is always the Doxa user ID; the
 * email travels with it so support can find a person by email.
 */
export const PERSON_PROPERTIES = z.object({
  email: z.email().max(254).optional(),
});

/** Person properties that keep their first value, such as how the person signed up. */
export const PERSON_FIRST_PROPERTIES = z.object({
  signup_method: signInMethod.optional(),
  created_at: isoTimestamp.optional(),
});

/**
 * The group types. `account` is the billing account (a person or a team), so
 * plan, trial and payment numbers count once per account. `project` is a
 * docs project.
 */
export const ANALYTICS_GROUPS = {
  account: z.object({
    owner_kind: z.enum(["user", "team"]).optional(),
    plan: codeToken.optional(),
    subscription_status: codeToken.optional(),
    interval: billingInterval.optional(),
    founder: flag.optional(),
    member_count: count.optional(),
    created_at: isoTimestamp.optional(),
  }),
  project: z.object({
    source: projectSource.optional(),
    has_custom_domain: flag.optional(),
    page_count_band: pageCountBand.optional(),
    created_at: isoTimestamp.optional(),
  }),
} as const;

/** Properties of an error report. The route is a pattern such as `/projects/:projectId`, never a URL with values. */
export const EXCEPTION_PROPERTIES = z.object({
  route: routePattern.optional(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(),
  status: z.number().int().min(100).max(599).optional(),
  request_id: opaqueId.optional(),
});
