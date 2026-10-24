import type { ProjectDto } from "@doxahq/contracts";
import type { OAuthScope } from "@doxahq/contracts/agent-access";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import type { Capability } from "@doxahq/api/services/agent-access/capabilities";
import type { AuthorizedProject } from "@doxahq/api/services/agent-access/project-access-policy";
import type { McpServices } from "./services/mcp-services";
import type { PlatformActions } from "./services/platform-actions";
import type { AgentActionKind } from "@doxahq/contracts/approval-requests";

export type ToolCost = "read" | "write" | "expensive";

export type ToolInputSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;

/** What a tool may use. It never sees the token, the env, or the request. */
export interface ToolContext {
  readonly actor: AgentActor;
  readonly services: McpServices;
  /** Consequential actions; they run in doxa-api under the approval policy. */
  readonly actions: PlatformActions;
  /** Throws `AccessDeniedError` when the policy refuses. */
  authorize(
    projectId: string,
    capability: Capability,
  ): Promise<AuthorizedProject>;
  listAccessibleProjects(): Promise<ProjectDto[]>;
}

export interface McpToolDefinition<
  TInput extends ToolInputSchema,
  TOutput extends z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Null: any valid token may call the tool. */
  readonly scope: OAuthScope | null;
  readonly cost: ToolCost;
  readonly annotations: ToolAnnotations;
  readonly input: TInput;
  readonly output: TOutput;
  /** Set only on tools that call the action gateway; checked by the registry tests. */
  readonly action?: AgentActionKind;
  /**
   * Set only on action tools: the approval request a result waits for, or
   * null. Tasks clients get that request as an MCP task (spec v2 §9).
   */
  pendingRequestOf?(output: z.infer<TOutput>): string | null;
  // Method syntax on purpose: it lets a list of tools with different schemas
  // share the erased `AnyMcpTool` type.
  run(context: ToolContext, input: z.infer<TInput>): Promise<z.infer<TOutput>>;
}

export type AnyMcpTool = McpToolDefinition<ToolInputSchema, z.ZodType>;

export function defineMcpTool<
  TInput extends ToolInputSchema,
  TOutput extends z.ZodType,
>(
  definition: McpToolDefinition<TInput, TOutput>,
): McpToolDefinition<TInput, TOutput> {
  return definition;
}
