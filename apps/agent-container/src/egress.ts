import type { ModelProvider } from "@doxahq/contracts";

/**
 * Egress control for the agent container.
 *
 * The container clones a customer repository and holds a repo-scoped GitHub
 * token and a short-lived model token. A flaw in a file parser could send
 * them to any host. The catch-all outbound handler below sees every HTTP and
 * HTTPS request of the container (HTTPS through `interceptHttps`) and decides
 * by host.
 *
 * Modes (`AGENT_EGRESS_MODE` on the agent-container Worker):
 * - `log`: forward every request, and log each host once per run, with what
 *   `enforce` would do.
 * - `enforce`: forward only hosts on the allow list, over HTTPS. Refuse every
 *   other request with 403 and a log line. The container has no direct
 *   internet (`enableInternet = false`), so traffic that the handler does not
 *   forward cannot leave.
 * - `off` (default, and any unknown value): the behavior before this control:
 *   direct internet, HTTPS is not intercepted, plain HTTP passes through
 *   without logs. A deploy therefore changes nothing until the mode is set.
 */
export type AgentEgressMode = "log" | "enforce" | "off";

export interface AgentEgressEnv {
  AGENT_EGRESS_MODE?: string;
  /**
   * More allowed hosts, separated by commas or spaces. An entry can be a host
   * (`api.example.com`) or a base URL (`https://gateway.example.com/v1`).
   * Set this when a model base URL changes, before the change ships.
   */
  AGENT_EGRESS_ALLOWED_HOSTS?: string;
}

/** Git clone and fetch: `createRepositoryUrl` in `src/git.ts`. */
export const GITHUB_GIT_HOST = "github.com";

/**
 * The base URL of each model provider. These must equal `defaultBaseUrl` in
 * `packages/agent/src/core/providers/*.ts`; a test checks this. The
 * `Record<ModelProvider, …>` type fails the typecheck when a provider is
 * added without a base URL here.
 */
export const MODEL_PROVIDER_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
} as const satisfies Record<ModelProvider, string>;

export function parseAgentEgressMode(value: string | undefined): AgentEgressMode {
  const mode = value?.trim().toLowerCase();
  return mode === "enforce" || mode === "log" ? mode : "off";
}

/** The container settings of a mode. */
export function agentEgressContainerSettings(env: AgentEgressEnv): {
  mode: AgentEgressMode;
  enableInternet: boolean;
  interceptHttps: boolean;
} {
  const mode = parseAgentEgressMode(env.AGENT_EGRESS_MODE);
  return {
    mode,
    enableInternet: mode !== "enforce",
    interceptHttps: mode !== "off",
  };
}

/**
 * A lowercase host name from a host or a URL, without a trailing dot.
 * Returns null for an empty or invalid entry.
 */
export function normalizeEgressHost(entry: string): string | null {
  const value = entry.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** The hosts that `enforce` forwards: GitHub, every model provider, and the configured extras. */
export function agentEgressAllowList(env: AgentEgressEnv): ReadonlySet<string> {
  const hosts = new Set<string>([GITHUB_GIT_HOST]);
  for (const baseUrl of Object.values(MODEL_PROVIDER_BASE_URLS)) {
    const host = normalizeEgressHost(baseUrl);
    if (host) hosts.add(host);
  }
  for (const entry of (env.AGENT_EGRESS_ALLOWED_HOSTS ?? "").split(/[\s,]+/)) {
    const host = normalizeEgressHost(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

export type AgentEgressDecision =
  | { allowed: true; host: string }
  | { allowed: false; host: string; reason: "host_not_listed" | "insecure_scheme" };

/**
 * What `enforce` does with a request URL. A listed host is allowed only over
 * HTTPS: a token must not cross the internet in clear text.
 */
export function decideAgentEgress(url: URL, allowList: ReadonlySet<string>): AgentEgressDecision {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!allowList.has(host)) return { allowed: false, host, reason: "host_not_listed" };
  if (url.protocol !== "https:") return { allowed: false, host, reason: "insecure_scheme" };
  return { allowed: true, host };
}

/** The most distinct hosts that one run logs; later hosts give one capped line. */
const MAX_LOGGED_HOSTS_PER_RUN = 64;
/** The most runs that the log book remembers in one isolate. */
const MAX_TRACKED_RUNS = 256;
/** A label longer than this can hold a token, so it is not logged as is. */
const MAX_LOGGED_LABEL_LENGTH = 32;

/**
 * Remembers which hosts each run has logged, so a host is logged once per
 * run. It lives in one Workers isolate, so a host can log once per isolate
 * when a run's requests reach more than one.
 */
export class AgentEgressLogBook {
  private readonly runs = new Map<string, { hosts: Set<string>; capped: boolean }>();

  /** Returns "log", "cap" (log the capped line once), or "skip". */
  record(runKey: string, entryKey: string): "log" | "cap" | "skip" {
    let run = this.runs.get(runKey);
    if (!run) {
      if (this.runs.size >= MAX_TRACKED_RUNS) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) this.runs.delete(oldest);
      }
      run = { hosts: new Set(), capped: false };
      this.runs.set(runKey, run);
    }
    if (run.hosts.has(entryKey)) return "skip";
    if (run.hosts.size >= MAX_LOGGED_HOSTS_PER_RUN) {
      if (run.capped) return "skip";
      run.capped = true;
      return "cap";
    }
    run.hosts.add(entryKey);
    return "log";
  }
}

/**
 * The host as it goes into a log line. A long label (a possible token used
 * as a subdomain) is replaced by its length.
 */
export function loggableEgressHost(host: string): string {
  return host
    .split(".")
    .map((label) => (label.length > MAX_LOGGED_LABEL_LENGTH ? `[label:${label.length}]` : label))
    .join(".");
}

export interface AgentEgressGateContext {
  containerId: string;
}

export interface AgentEgressGateDependencies {
  fetch?: (request: Request) => Promise<Response>;
  log?: (line: string) => void;
  logBook?: AgentEgressLogBook;
}

/** The response that the container gets for a refused request. */
export function refusedEgressResponse(decision: Extract<AgentEgressDecision, { allowed: false }>): Response {
  const why = decision.reason === "insecure_scheme"
    ? "this host is allowed only over HTTPS"
    : "this host is not on the egress allow list of the agent container";
  return new Response(
    `Doxa refused an outbound request to ${loggableEgressHost(decision.host)}: ${why}.\n`,
    {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-doxa-egress": "refused",
      },
    },
  );
}

/** The catch-all outbound handler of the agent container. */
export function createAgentEgressGate(deps: AgentEgressGateDependencies = {}) {
  const forward = deps.fetch ?? ((request: Request) => fetch(request));
  const log = deps.log ?? ((line: string) => console.log(line));
  const logBook = deps.logBook ?? new AgentEgressLogBook();

  return async function agentEgressGate(
    request: Request,
    env: AgentEgressEnv,
    ctx: AgentEgressGateContext,
  ): Promise<Response> {
    const mode = parseAgentEgressMode(env.AGENT_EGRESS_MODE);
    if (mode === "off") return forward(request);

    const url = new URL(request.url);
    const decision = decideAgentEgress(url, agentEgressAllowList(env));
    const refuse = mode === "enforce" && !decision.allowed;
    const scheme = url.protocol.replace(/:$/, "");
    const entry = logBook.record(ctx.containerId, `${scheme}://${decision.host}:${url.port}`);
    if (entry === "log") {
      log(JSON.stringify({
        service: "doxa-agent-container-wrapper",
        eventType: refuse ? "agent_egress_refused" : "agent_egress",
        mode,
        containerId: ctx.containerId,
        host: loggableEgressHost(decision.host),
        scheme,
        ...(url.port ? { port: url.port } : {}),
        listed: decision.allowed,
        ...(decision.allowed ? {} : { reason: decision.reason }),
        outcome: refuse ? "refused" : "forwarded",
      }));
    } else if (entry === "cap") {
      log(JSON.stringify({
        service: "doxa-agent-container-wrapper",
        eventType: "agent_egress_log_capped",
        mode,
        containerId: ctx.containerId,
        maxHosts: MAX_LOGGED_HOSTS_PER_RUN,
      }));
    }

    if (mode === "enforce" && !decision.allowed) return refusedEgressResponse(decision);
    return forward(request);
  };
}

export const agentEgressGate = createAgentEgressGate();
