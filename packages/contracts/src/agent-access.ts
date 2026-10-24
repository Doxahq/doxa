import { z } from "zod";

export const OAUTH_SCOPES = [
  "projects:read",
  "projects:write",
  "docs:read",
  "docs:write",
  "site:write",
  "domains:write",
  "publish",
  "generation:run",
] as const;

export const oauthScopeSchema = z.enum(OAUTH_SCOPES);

export type OAuthScope = z.infer<typeof oauthScopeSchema>;

const OAUTH_SCOPE_SET: ReadonlySet<string> = new Set(OAUTH_SCOPES);

export function isOAuthScope(value: string): value is OAuthScope {
  return OAUTH_SCOPE_SET.has(value);
}

/**
 * Direct implications only. A write scope implies the read scope it builds on,
 * never the other way around, so a read-only grant stays read-only.
 */
export const OAUTH_SCOPE_IMPLICATIONS = {
  "projects:read": [],
  "projects:write": ["projects:read"],
  "docs:read": [],
  "docs:write": ["docs:read"],
  "site:write": ["docs:read"],
  "domains:write": ["projects:read"],
  publish: ["docs:read"],
  "generation:run": ["projects:read"],
} as const satisfies Record<OAuthScope, readonly OAuthScope[]>;

export const MAX_GRANT_PROJECT_IDS = 100;

export const projectScopeClaimSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("selected"),
      projectIds: z
        .array(z.uuid())
        .min(1)
        .max(MAX_GRANT_PROJECT_IDS)
        .refine((ids) => new Set(ids).size === ids.length, {
          message: "Project IDs must be unique",
        }),
    })
    .strict(),
]);

export type ProjectScopeClaim = z.infer<typeof projectScopeClaimSchema>;

export const AGENT_GRANT_PROPS_VERSION = 1;

/**
 * Stored in the OAuth provider grant. Parsed on every read: an unknown version
 * makes the token invalid. Holds no personal data beyond the user ID.
 */
export const agentGrantPropsSchema = z
  .object({
    version: z.literal(AGENT_GRANT_PROPS_VERSION),
    grantRef: z.uuid(),
    userId: z.string().min(1),
    clientName: z.string().min(1).max(200),
    projectScope: projectScopeClaimSchema,
  })
  .strict();

export type AgentGrantProps = z.infer<typeof agentGrantPropsSchema>;

/** What the consent page shows about the agent that asks for access. */
export const agentConsentClientSchema = z
  .object({
    name: z.string().min(1).max(200),
    /** The client ID URL when the client uses a client ID metadata document. */
    metadataUrl: z.url().nullable(),
    /** False for a dynamically registered client: its name is self-declared. */
    verified: z.boolean(),
    redirectHost: z.string().min(1),
  })
  .strict();

export const agentConsentProjectSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    /** The consent page groups projects by team; null for personal projects. */
    team: z.object({ id: z.uuid(), name: z.string() }).strict().nullable(),
  })
  .strict();

export const agentConsentDetailsSchema = z
  .object({
    consentId: z.string().min(1),
    client: agentConsentClientSchema,
    requestedScopes: z.array(oauthScopeSchema),
    projects: z.array(agentConsentProjectSchema),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const approveAgentConsentInputSchema = z
  .object({
    scopes: z.array(oauthScopeSchema).min(1),
    projectScope: projectScopeClaimSchema,
  })
  .strict();

export const agentConsentDecisionSchema = z
  .object({ redirectTo: z.url() })
  .strict();

export const agentGrantSummarySchema = z
  .object({
    grantId: z.string().min(1),
    clientName: z.string(),
    scopes: z.array(oauthScopeSchema),
    projectScope: projectScopeClaimSchema,
    createdAt: z.iso.datetime(),
    lastActivityAt: z.iso.datetime().nullable(),
  })
  .strict();

export const agentGrantListSchema = z
  .object({ grants: z.array(agentGrantSummarySchema) })
  .strict();

export type AgentConsentClient = z.infer<typeof agentConsentClientSchema>;
export type AgentConsentProject = z.infer<typeof agentConsentProjectSchema>;
export type AgentConsentDetails = z.infer<typeof agentConsentDetailsSchema>;
export type ApproveAgentConsentInput = z.infer<typeof approveAgentConsentInputSchema>;
export type AgentConsentDecision = z.infer<typeof agentConsentDecisionSchema>;
export type AgentGrantSummary = z.infer<typeof agentGrantSummarySchema>;
export type AgentGrantList = z.infer<typeof agentGrantListSchema>;
