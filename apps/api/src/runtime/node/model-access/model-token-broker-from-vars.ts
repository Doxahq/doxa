import {
  FederatedModelTokenBroker,
  type ModelFederationConfig,
  type ModelTokenBroker,
} from "../../../services/model-access/model-token-broker";
import { stsIdentityTokenProvider } from "./sts-identity-token";

const FEDERATION_VARS = {
  federationRuleId: "ANTHROPIC_FEDERATION_RULE_ID",
  organizationId: "ANTHROPIC_ORGANIZATION_ID",
  serviceAccountId: "ANTHROPIC_SERVICE_ACCOUNT_ID",
  workspaceId: "ANTHROPIC_WORKSPACE_ID",
} as const satisfies Record<keyof ModelFederationConfig, string>;

const DEFAULT_AWS_REGION = "us-east-1";

/**
 * The model token broker of the origin, or undefined when federation is not
 * set up, as in local development: the generation then keeps its static key.
 * Some variables without the others is a configuration error, so the origin
 * refuses to start rather than fall back in silence.
 */
export function modelTokenBrokerFromVars(vars: Record<string, unknown>): ModelTokenBroker | undefined {
  const config = federationConfigFromVars(vars);
  if (!config) return undefined;
  return new FederatedModelTokenBroker({
    config,
    identityToken: stsIdentityTokenProvider(stringVar(vars, "AWS_REGION") ?? DEFAULT_AWS_REGION),
  });
}

/** Exported for tests. */
export function federationConfigFromVars(vars: Record<string, unknown>): ModelFederationConfig | null {
  const names = Object.values(FEDERATION_VARS);
  const missing = names.filter((name) => stringVar(vars, name) === undefined);
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new Error(`Model federation is half set up. Set ${missing.join(", ")} too, or remove the others.`);
  }

  return {
    federationRuleId: requiredVar(vars, FEDERATION_VARS.federationRuleId),
    organizationId: requiredVar(vars, FEDERATION_VARS.organizationId),
    serviceAccountId: requiredVar(vars, FEDERATION_VARS.serviceAccountId),
    workspaceId: requiredVar(vars, FEDERATION_VARS.workspaceId),
  };
}

function stringVar(vars: Record<string, unknown>, name: string): string | undefined {
  const value = vars[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredVar(vars: Record<string, unknown>, name: string): string {
  const value = stringVar(vars, name);
  if (value === undefined) throw new Error(`${name} must be set.`);
  return value;
}
