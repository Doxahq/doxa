import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
} from "@modelcontextprotocol/client";
import {
  OAUTH_SCOPES,
  type AgentGrantProps,
  type ProjectScopeClaim,
} from "@doxahq/contracts/agent-access";
import {
  handleAuthenticatedMcpRequest,
  type AuthenticatedRequestContext,
  type McpRuntime,
} from "../../src/authenticated-request";
import type {
  McpFailureLogEntry,
  ToolCallLogEntry,
} from "../../src/logger";
import type { McpEnv } from "../../src/mcp-env";
import type { McpRequestContext } from "../../src/request-context";
import { createPlatformActions } from "../../src/services/platform-actions";
import type { PerformActionRpcInput } from "@doxahq/api/services/agent-actions/rpc-contract";
import {
  createFakeActionsRpc,
  fakeApprovalRow,
  type FakeApprovalRow,
  type FakeOutcomes,
} from "./fake-actions-rpc";
import type { McpServices } from "../../src/services/mcp-services";
import type { AgentActivityRecord } from "@doxahq/api/repositories/agent-activity";
import type { NewAgentLiveEvent } from "@doxahq/api/repositories/agent-live-events";
import type { AgentActor } from "@doxahq/api/services/agent-access/actor";
import { MembershipProjectAccessPolicy } from "@doxahq/api/services/agent-access/membership-project-access-policy";
import type { TeamRole } from "@doxahq/contracts/teams";
import { InMemoryProjectAccess } from "@doxahq/api/tests/support/in-memory-project-access";
import { createMemoryR2Bucket } from "@doxahq/api/tests/support/memory-r2-bucket";
import { createFakeServices, type ServiceCall } from "./fake-services";
import type { AppliedEdits } from "./fake-write-services";
import {
  CREATED_AT,
  GRANT_REF,
  OTHER,
  OWNER,
  project,
  PROJECT_OWNERS,
  PROJECT_TEAMS,
  TEAM_ID,
  TEAM_NAME,
} from "./fixtures";

export const RESOURCE_URL = "http://localhost:8791/mcp";
export const REQUEST_ID = "99999999-9999-4999-8999-999999999999";

export type RecordedLiveEvent = NewAgentLiveEvent & { projectId: string };

export interface HarnessOptions {
  userId?: string;
  scopes?: readonly string[];
  projectScope?: ProjectScopeClaim;
  rateLimited?: boolean;
  props?: unknown;
  /** Replaces parts of the fake services for one test. */
  services?: (fakes: McpServices) => McpServices;
  /** The fake doxa-api actions RPC; records calls in `actionCalls`. */
  actions?: FakeOutcomes;
  /** The approval request the fake doxa-api stores; pending by default. */
  approval?: FakeApprovalRow;
  /** The actor's role in TEAM_ID, which shares PROJECT_TEAM. Not a member by default. */
  teamRole?: TeamRole;
}

export interface Harness {
  readonly calls: ServiceCall[];
  /** Edits the fake docs service wrote (dry runs are not recorded). */
  readonly written: AppliedEdits[];
  readonly activity: AgentActivityRecord[];
  readonly liveEvents: RecordedLiveEvent[];
  readonly toolCalls: ToolCallLogEntry[];
  readonly failures: McpFailureLogEntry[];
  readonly limiterCalls: string[];
  readonly closed: { count: number };
  readonly actionCalls: PerformActionRpcInput[];
  fetch(request: Request): Promise<Response>;
  /** `capabilities` are the client's own, sent with every 2026 request. */
  connect(mode: "modern" | "legacy", capabilities?: ClientCapabilities): Promise<Client>;
  /** Waits for every `waitUntil` promise. */
  settle(): Promise<void>;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const userId = options.userId ?? OWNER;
  const scopes = [...(options.scopes ?? OAUTH_SCOPES)];
  const props: unknown =
    options.props ?? grantProps(userId, options.projectScope);
  const state = createState();
  const runtime = createRuntime(state, options);
  const ctx: AuthenticatedRequestContext = {
    props,
    auth: {
      token: "test-token",
      audience: RESOURCE_URL,
      scope: scopes,
      userId,
      clientId: "client-1",
    },
    waitUntil: (promise) => state.pending.push(promise),
  };
  const fetch = (request: Request) =>
    handleAuthenticatedMcpRequest(request, testEnv(), ctx, runtime);
  return {
    ...state,
    fetch,
    connect: (mode, capabilities) => connectClient(fetch, mode, capabilities),
    settle: async () => {
      await Promise.all(state.pending);
    },
  };
}

interface HarnessState {
  calls: ServiceCall[];
  written: AppliedEdits[];
  activity: AgentActivityRecord[];
  liveEvents: RecordedLiveEvent[];
  toolCalls: ToolCallLogEntry[];
  failures: McpFailureLogEntry[];
  limiterCalls: string[];
  closed: { count: number };
  pending: Promise<unknown>[];
  actionCalls: PerformActionRpcInput[];
}

function createState(): HarnessState {
  return {
    calls: [],
    written: [],
    activity: [],
    liveEvents: [],
    toolCalls: [],
    failures: [],
    limiterCalls: [],
    closed: { count: 0 },
    pending: [],
    actionCalls: [],
  };
}

function createRuntime(
  state: HarnessState,
  options: HarnessOptions,
): McpRuntime {
  const approval = options.approval ?? fakeApprovalRow();
  return {
    openContext: (_env, actor, waitUntil) => ({
      context: testContext(state, actor, waitUntil, options, approval),
      close: async () => {
        state.closed.count += 1;
      },
    }),
  };
}

function testContext(
  state: HarnessState,
  actor: AgentActor,
  waitUntil: (promise: Promise<unknown>) => void,
  options: HarnessOptions,
  approval: FakeApprovalRow,
): McpRequestContext {
  let clock = 1_000;
  const rateLimited = options.rateLimited ?? false;
  const userId = actor.principal.userId;
  const teams =
    options.teamRole === undefined
      ? []
      : [
          {
            id: TEAM_ID,
            name: TEAM_NAME,
            role: options.teamRole,
            memberCount: 2,
            projectCount: 1,
            createdAt: CREATED_AT,
          },
        ];
  const fakes = createFakeServices(state.calls, state.written, teams);
  const actionsRpc = createFakeActionsRpc(options.actions, state.actionCalls, approval);
  return {
    requestId: REQUEST_ID,
    actor,
    policy: new MembershipProjectAccessPolicy(
      new InMemoryProjectAccess(
        Object.fromEntries(
          Object.entries(PROJECT_OWNERS).map(([id, owner]) => [id, { owner, teamId: PROJECT_TEAMS[id] ?? null }]),
        ),
        {
          [TEAM_ID]: {
            [OTHER]: "owner",
            ...(options.teamRole === undefined ? {} : { [userId]: options.teamRole }),
          },
        },
        (id) => project(id),
      ),
    ),
    services: options.services ? options.services(fakes) : fakes,
    actions: createPlatformActions(actionsRpc.rpc, actor),
    limiter: {
      allow: async (cost) => {
        state.limiterCalls.push(cost);
        return !rateLimited;
      },
    },
    activity: { append: async (record) => void state.activity.push(record) },
    liveEvents: {
      append: async (projectId, events) =>
        void state.liveEvents.push(...events.map((event) => ({ ...event, projectId }))),
    },
    logger: {
      toolCall: (entry) => state.toolCalls.push(entry),
      failure: (entry) => state.failures.push(entry),
    },
    waitUntil,
    now: () => (clock += 5),
  };
}

function grantProps(
  userId: string,
  projectScope?: ProjectScopeClaim,
): AgentGrantProps {
  return {
    version: 1,
    grantRef: GRANT_REF,
    userId,
    clientName: "Test Agent",
    projectScope: projectScope ?? { kind: "all" },
  };
}

function testEnv(): McpEnv {
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  return {
    AUTH_SERVER: { validateToken: async () => null },
    DOCS_BUCKET: createMemoryR2Bucket().bucket,
    MCP_READ_LIMITER: limiter,
    MCP_WRITE_LIMITER: limiter,
    MCP_EXPENSIVE_LIMITER: limiter,
    MCP_RESOURCE_URL: RESOURCE_URL,
    OAUTH_ISSUER: "http://localhost:8787",
  };
}

async function connectClient(
  fetch: (request: Request) => Promise<Response>,
  mode: "modern" | "legacy",
  capabilities: ClientCapabilities = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE_URL), {
    fetch: (url, init) => fetch(workerRequest(url, init)),
  });
  const client = new Client(
    { name: "doxa-test", version: "1.0.0" },
    {
      versionNegotiation: {
        mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
      },
      capabilities,
    },
  );
  await client.connect(transport);
  return client;
}

/** Node's fetch leaves out the Host header that workerd always sets. */
export function workerRequest(url: string | URL, init?: RequestInit): Request {
  const request = new Request(url, init);
  request.headers.set("host", new URL(url).host);
  return request;
}
