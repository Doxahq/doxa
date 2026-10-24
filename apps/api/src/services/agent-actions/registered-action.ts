import type { z } from "zod";
import type { OAuthScope } from "@doxahq/contracts/agent-access";
import type { AgentActionKind, ReviewSurface } from "@doxahq/contracts/approval-requests";
import type { Capability } from "../agent-access/capabilities";
import type {
  ActionApprovalRules,
  ActionContext,
  ActionDescription,
  ActionExecution,
  ActionTarget,
  AgentActionDefinition,
  ApprovalChoices,
  PrincipalTarget,
  ProjectTarget,
  ReviewInputs,
} from "./action-definition";
import { ActionInputError } from "./errors";
import type { Freshness } from "./freshness";

/**
 * An action with its payload and snapshot bound. The gateway and the
 * approval service work only with this shape, so they never need the
 * generic types of each definition.
 */
export interface PreparedAction {
  readonly payload: unknown;
  readonly snapshot: unknown;
  readonly targetKey: string;
  readonly description: ActionDescription;
  readonly inputs: ReviewInputs;
  readonly branchId: string | null;
  readonly confirmationText: string | null;
  /** True when a stored request holds the same payload and snapshot. */
  matches(stored: { payload: unknown; snapshot: unknown }): boolean;
  checkFresh(context: ActionContext): Promise<Freshness>;
  execute(execution: ActionExecution): Promise<unknown>;
  /** The same action with the decider's choices applied to the payload. */
  withChoices(choices: ApprovalChoices): PreparedAction;
}

export interface RegisteredAction<K extends AgentActionKind = AgentActionKind> {
  readonly kind: K;
  readonly title: string;
  readonly scope: OAuthScope;
  readonly capability: Capability;
  readonly approval: ActionApprovalRules;
  readonly review: ReviewSurface;
  readonly payloadVersion: number;
  readonly targetKind: ActionTarget["kind"];
  /** Parses the payload, then captures the snapshot. */
  prepare(context: ActionContext, rawPayload: unknown): Promise<PreparedAction>;
  /** Rebuilds a stored request. Null when the stored row no longer parses. */
  restore(stored: { payload: unknown; snapshot: unknown }): PreparedAction | null;
}

/** Keeps the payload and result types for callers that name the kind. */
export interface TypedRegisteredAction<K extends AgentActionKind, TPayload, TResult>
  extends RegisteredAction<K> {
  readonly payloadSchema: z.ZodType<TPayload>;
  readonly resultSchema: z.ZodType<TResult>;
}

export function defineProjectAction<K extends AgentActionKind, P, S, R>(
  definition: AgentActionDefinition<K, ProjectTarget, P, S, R>,
): TypedRegisteredAction<K, P, R> {
  return register(definition, "project", (target) => (target.kind === "project" ? target : null));
}

export function definePrincipalAction<K extends AgentActionKind, P, S, R>(
  definition: AgentActionDefinition<K, PrincipalTarget, P, S, R>,
): TypedRegisteredAction<K, P, R> {
  return register(definition, "principal", (target) =>
    target.kind === "principal" ? target : null,
  );
}

function register<K extends AgentActionKind, T extends ActionTarget, P, S, R>(
  definition: AgentActionDefinition<K, T, P, S, R>,
  targetKind: T["kind"],
  narrow: (target: ActionTarget) => T | null,
): TypedRegisteredAction<K, P, R> {
  const bind = (payload: P, snapshot: S): PreparedAction =>
    bindAction(definition, narrow, payload, snapshot);
  return {
    kind: definition.kind,
    title: definition.title,
    scope: definition.scope,
    capability: definition.capability,
    approval: definition.approval,
    review: definition.review,
    payloadVersion: definition.payloadVersion,
    payloadSchema: definition.payloadSchema,
    resultSchema: definition.resultSchema,
    targetKind,
    async prepare(context, rawPayload) {
      const parsed = definition.payloadSchema.safeParse(rawPayload);
      if (!parsed.success) throw new ActionInputError(parsed.error.message);
      const snapshot = await definition.capture(withTarget(context, narrow), parsed.data);
      return bind(parsed.data, snapshot);
    },
    restore(stored) {
      const payload = definition.payloadSchema.safeParse(stored.payload);
      const snapshot = definition.snapshotSchema.safeParse(stored.snapshot);
      return payload.success && snapshot.success ? bind(payload.data, snapshot.data) : null;
    },
  };
}

function bindAction<K extends AgentActionKind, T extends ActionTarget, P, S, R>(
  definition: AgentActionDefinition<K, T, P, S, R>,
  narrow: (target: ActionTarget) => T | null,
  payload: P,
  snapshot: S,
): PreparedAction {
  const prepared: PreparedAction = {
    payload,
    snapshot,
    targetKey: definition.targetKey(payload),
    description: definition.describe(payload, snapshot),
    inputs: definition.reviewInputs(payload),
    branchId: definition.branchId?.(payload) ?? null,
    confirmationText: definition.confirmationText?.(payload, snapshot) ?? null,
    matches: (stored) =>
      stableJson(stored.payload) === stableJson(payload) &&
      stableJson(stored.snapshot) === stableJson(snapshot),
    checkFresh: (context) => definition.checkFresh(withTarget(context, narrow), payload, snapshot),
    async execute(execution) {
      const target = narrowOrThrow(execution.target, narrow);
      const result = await definition.execute({ ...execution, target }, payload, snapshot);
      return definition.resultSchema.parse(result);
    },
    withChoices: (choices) =>
      definition.applyChoices
        ? bindAction(definition, narrow, definition.applyChoices(payload, choices), snapshot)
        : prepared,
  };
  return prepared;
}

function withTarget<T extends ActionTarget>(
  context: ActionContext,
  narrow: (target: ActionTarget) => T | null,
): ActionContext<T> {
  return { ...context, target: narrowOrThrow(context.target, narrow) };
}

// The gateway picks the target from `targetKind`, so a mismatch is a bug.
function narrowOrThrow<T extends ActionTarget>(
  target: ActionTarget,
  narrow: (target: ActionTarget) => T | null,
): T {
  const narrowed = narrow(target);
  if (narrowed === null) throw new Error(`Action target mismatch: ${target.kind}`);
  return narrowed;
}

/** JSON with sorted keys, so equal values compare equal whatever the key order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
