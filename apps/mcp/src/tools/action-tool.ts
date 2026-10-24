import { actionToolOutputSchema, type AgentActionKind } from "@doxahq/contracts/approval-requests";
import type { OAuthScope } from "@doxahq/contracts/agent-access";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { PerformActionRpcOutput } from "@doxahq/api/services/agent-actions/rpc-contract";
import { defineMcpTool, type McpToolDefinition, type ToolInputSchema } from "../tool-definition";

export interface ActionCall {
  readonly projectId: string | null;
  readonly payload: unknown;
  readonly summary?: string | null;
}

export interface ActionToolSpec<TInput extends ToolInputSchema, TResult extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly action: AgentActionKind;
  /** Must equal the action's scope; the registry tests check it. */
  readonly scope: OAuthScope;
  readonly annotations: ToolAnnotations;
  readonly input: TInput;
  /** The action's own result schema, so the tool and doxa-api agree. */
  readonly result: TResult;
  toCall(input: z.infer<TInput>): ActionCall;
}

const APPROVAL_NOTE =
  "If the result is approval_required, give the user the approvalUrl and wait: call get_approval_request after pollAfterMs.";

/**
 * Spec 9.8: an action tool only builds the payload. doxa-api runs the
 * policy, so the tool returns the same union whether the action is gated.
 */
export function defineActionTool<TInput extends ToolInputSchema, TResult extends z.ZodType>(
  spec: ActionToolSpec<TInput, TResult>,
) {
  const output = actionToolOutputSchema(spec.result);
  const tool: McpToolDefinition<TInput, typeof output> = {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} ${APPROVAL_NOTE}`,
    scope: spec.scope,
    cost: "expensive",
    annotations: spec.annotations,
    input: spec.input,
    output,
    action: spec.action,
    pendingRequestOf: (result) => (result.outcome === "approval_required" ? (result.request?.id ?? null) : null),
    async run(context, input) {
      const call = spec.toCall(input);
      const outcome = await context.actions.perform({
        action: spec.action,
        projectId: call.projectId,
        payload: call.payload,
        summary: call.summary ?? null,
      });
      return toToolOutput(outcome, spec.result);
    },
  };
  return defineMcpTool(tool);
}

function toToolOutput<TResult extends z.ZodType>(outcome: PerformActionRpcOutput, result: TResult) {
  if (outcome.outcome === "completed") {
    return { outcome: "completed" as const, result: result.parse(outcome.result) };
  }
  return { outcome: "approval_required" as const, request: outcome.pending, message: outcome.message };
}

export const destructiveActionAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

export const additiveActionAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
