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
    /** Set for an agent token from the claim flow. An OAuth grant renews itself. */
    expiresAt: z.iso.datetime().nullable(),
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

/** The grant type of the auth.md claim flow. The protocol defines this name. */
export const AGENT_CLAIM_GRANT_TYPE = "urn:workos:agent-auth:grant-type:claim";
export const AGENT_IDENTITY_TYPE = "service_auth";
/** Every agent token has its own client ID with this prefix. */
export const AGENT_TOKEN_CLIENT_ID_PREFIX = "doxa-agent-token:";

export function isAgentTokenClientId(clientId: string): boolean {
  return clientId.startsWith(AGENT_TOKEN_CLIENT_ID_PREFIX);
}
export const AGENT_USER_CODE_LENGTH = 6;
export const AGENT_DISPLAY_NAME_MAX_LENGTH = 60;

const AGENT_ATTEMPT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Letters, digits, and simple punctuation: a name cannot imitate page text with markup or line breaks. */
const AGENT_DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} ._:()/-]+$/u;

const agentDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_DISPLAY_NAME_MAX_LENGTH)
  .regex(AGENT_DISPLAY_NAME_PATTERN);

/** The body of `POST /agent/identity`. The field names follow the auth.md protocol. */
export const agentIdentityRequestSchema = z.object({
  type: z.literal(AGENT_IDENTITY_TYPE),
  login_hint: z.email().max(254).toLowerCase().optional(),
  client_name: agentDisplayNameSchema.optional(),
  token_name: agentDisplayNameSchema.optional(),
  /** OAuth format: scopes separated by spaces. */
  scope: z.string().max(500).optional(),
});

const agentClaimAttemptSchema = z.string().regex(AGENT_ATTEMPT_TOKEN_PATTERN);

/** Secrets travel in the body, so they stay out of URLs and access logs. */
export const agentClaimReferenceSchema = z
  .object({ attemptToken: agentClaimAttemptSchema })
  .strict();

export const approveAgentClaimInputSchema = approveAgentConsentInputSchema
  .extend({
    attemptToken: agentClaimAttemptSchema,
    userCode: z.string().regex(new RegExp(`^\\d{${AGENT_USER_CODE_LENGTH}}$`)),
  })
  .strict();

export const agentClaimDetailsSchema = z
  .object({
    clientName: z.string().min(1).max(AGENT_DISPLAY_NAME_MAX_LENGTH),
    tokenName: z.string().min(1).max(AGENT_DISPLAY_NAME_MAX_LENGTH),
    requestedScopes: z.array(oauthScopeSchema),
    projects: z.array(agentConsentProjectSchema),
    /** The email that the agent named, or null when it named none. */
    loginHint: z.string().nullable(),
    /** False when the agent named an email of a different account. */
    accountMatches: z.boolean(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export type AgentIdentityRequest = z.infer<typeof agentIdentityRequestSchema>;
export type AgentClaimReference = z.infer<typeof agentClaimReferenceSchema>;
export type ApproveAgentClaimInput = z.infer<typeof approveAgentClaimInputSchema>;
export type AgentClaimDetails = z.infer<typeof agentClaimDetailsSchema>;
