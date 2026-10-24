/**
 * The agent action registry (spec 8.2, 8.9).
 *
 * Each consequential agent action is one module in `actions/` that exports a
 * definition. The gateway, the approval service, and the MCP tools read the
 * gate from the definition, so changing a gate changes one file:
 *
 * - Ungate an action: set `approval.defaultMode` to "allow" in its module.
 * - Gate it for one project or user: add an entry to
 *   `policy/platform-overrides.ts`. No other change.
 * - Add an action: add a module, add it to the list below and to
 *   `AGENT_ACTION_KINDS` in `@doxahq/contracts/approval-requests`, then add
 *   the MCP tool with `action: "<kind>"`. No migration: `action_kind` is text.
 * - Remove an action: remove the tool and the entry here. The cron expires
 *   pending rows of an unknown kind with `action_removed`.
 * - User-chosen gates (planned): add sources to the resolver list in
 *   `action-runtime.ts`. Definitions, gateway and tools stay the same.
 *
 * `allowedModes` is the floor and the ceiling for every policy source.
 */
import type { z } from "zod";
import { isAgentActionKind, type AgentActionKind } from "@doxahq/contracts/approval-requests";
import type { ActionApprovalRules } from "./action-definition";
import { docsPublishAction } from "./actions/docs-publish";
import { docsRestoreAction } from "./actions/docs-restore";
import { domainAddAction } from "./actions/domain-add";
import { domainCheckAction } from "./actions/domain-check";
import { domainRemoveAction } from "./actions/domain-remove";
import { generationCancelAction } from "./actions/generation-cancel";
import { generationStartAction } from "./actions/generation-start";
import { projectCreateAction } from "./actions/project-create";
import { projectDeleteAction } from "./actions/project-delete";
import type { RegisteredAction } from "./registered-action";

export type { AgentActionKind };

export interface ActionRegistry {
  readonly kinds: readonly AgentActionKind[];
  /** Undefined for a kind that a release removed. */
  find(kind: string): RegisteredAction | undefined;
  get(kind: AgentActionKind): RegisteredAction;
  rulesFor(kind: AgentActionKind): ActionApprovalRules;
}

/** Throws at module load on a duplicate kind, so a bad registry never ships. */
export function defineActionRegistry(actions: readonly RegisteredAction[]): ActionRegistry {
  const byKind = new Map<string, RegisteredAction>();
  for (const action of actions) {
    if (byKind.has(action.kind)) throw new Error(`Duplicate agent action kind: ${action.kind}`);
    byKind.set(action.kind, action);
  }
  const get = (kind: AgentActionKind): RegisteredAction => {
    const action = byKind.get(kind);
    if (action === undefined) throw new Error(`Unregistered agent action kind: ${kind}`);
    return action;
  };
  return {
    kinds: actions.map((action) => action.kind),
    find: (kind) => (isAgentActionKind(kind) ? byKind.get(kind) : undefined),
    get,
    rulesFor: (kind) => get(kind).approval,
  };
}

export const ACTION_DEFINITIONS = [
  docsPublishAction,
  docsRestoreAction,
  domainAddAction,
  domainRemoveAction,
  projectCreateAction,
  projectDeleteAction,
  generationStartAction,
  generationCancelAction,
  domainCheckAction,
] as const;

export const AGENT_ACTIONS = defineActionRegistry(ACTION_DEFINITIONS);

type DefinitionFor<K extends AgentActionKind> = Extract<
  (typeof ACTION_DEFINITIONS)[number],
  { readonly kind: K }
>;

/** The parsed payload of one action, for callers that build it (MCP tools). */
export type ActionPayload<K extends AgentActionKind> = z.output<DefinitionFor<K>["payloadSchema"]>;

export type ActionResult<K extends AgentActionKind> = z.output<DefinitionFor<K>["resultSchema"]>;
