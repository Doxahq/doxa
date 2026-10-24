import type {
  ProjectShell,
  ProjectShellSectionError,
  ProjectShellSectionKey,
} from "@doxahq/contracts/project-shell";
import type { ApiContext } from "../http/app";
import { toSafeErrorLog } from "../http/error-log";
import { keepRunning } from "../http/progress-stream";
import {
  forbidden,
  withProjectAccess,
  type DashboardProjectAccess,
} from "../http/project-access";
import { requestState } from "../http/request-state";
import { json } from "../http/response";
import type { Capability } from "../services/agent-access/capabilities";
import { listProjectApprovalRequests } from "./approval-requests";
import { listDocsBranches } from "./docs-branches";
import { listDocsDomains } from "./docs-domains";
import { listPendingMerges, readDoxabotSettings } from "./doxabot";
import { readGenerationReview } from "./generation-reviews";
import { listGenerationsPage, readProjectDetail } from "./project-reads";

/** How long one section may take before it answers with a timeout. */
export const PROJECT_SHELL_SECTION_TIMEOUT_MS = 2_000;

/** The generations page that the Overview shows first. */
const OVERVIEW_GENERATIONS_LIMIT = 20;

export interface ProjectShellSection {
  /**
   * The capability of the endpoint that the section replaces. Null when the
   * section's service checks the access itself.
   */
  readonly capability: Capability | null;
  /** The endpoint's response, after the capability check. */
  load(context: ApiContext, access: DashboardProjectAccess): Promise<Response>;
}

export const PROJECT_SHELL_SECTIONS: Readonly<
  Record<ProjectShellSectionKey, ProjectShellSection>
> = {
  project: { capability: "project.read", load: readProjectDetail },
  generationReview: { capability: "docs.read", load: readGenerationReview },
  pendingMerges: { capability: "project.read", load: listPendingMerges },
  doxabot: { capability: "project.read", load: readDoxabotSettings },
  generations: {
    capability: "generation.read",
    load: (context, access) =>
      listGenerationsPage(context, access, {
        limit: OVERVIEW_GENERATIONS_LIMIT,
        cursor: null,
      }),
  },
  branches: { capability: "docs.read", load: listDocsBranches },
  pendingApprovalRequests: {
    capability: null,
    load: (context, access) =>
      listProjectApprovalRequests(context, access.actorUserId, "pending"),
  },
  docsDomains: { capability: "domains.read", load: listDocsDomains },
};

export interface ProjectShellOptions {
  sections?: Readonly<Record<ProjectShellSectionKey, ProjectShellSection>>;
  timeoutMs?: number;
}

/**
 * `GET /projects/:projectId/shell` (see `@doxahq/contracts/project-shell`).
 * One session check and one access check, then every section at the same
 * time on the request's database scope. Each section keeps the capability
 * check and the response of its own endpoint.
 */
export function handleProjectShell(
  context: ApiContext,
  options: ProjectShellOptions = {},
): Promise<Response> {
  const sections = options.sections ?? PROJECT_SHELL_SECTIONS;
  const timeoutMs = options.timeoutMs ?? PROJECT_SHELL_SECTION_TIMEOUT_MS;

  return withProjectAccess(context, "project.read", async (access) => {
    const entries = await Promise.all(
      (Object.keys(sections) as ProjectShellSectionKey[]).map(
        async (key) =>
          [
            key,
            await readSection(context, access, key, sections[key], timeoutMs),
          ] as const,
      ),
    );
    return json(Object.fromEntries(entries) as ProjectShell);
  });
}

type SectionResult = { data: unknown } | { error: ProjectShellSectionError };

async function readSection(
  context: ApiContext,
  access: DashboardProjectAccess,
  key: ProjectShellSectionKey,
  section: ProjectShellSection,
  timeoutMs: number,
): Promise<SectionResult> {
  if (section.capability && !access.capabilities.has(section.capability)) {
    return toSectionResult(forbidden());
  }

  const timing = requestState(context.req.raw, context.env).timing;
  const loading = timing.measure(`shell.${key}`, () =>
    Promise.resolve().then(() => section.load(context, access)),
  );
  // A section that times out still runs to its end, so it never queries a
  // closed database scope.
  keepRunning(context, loading.catch(() => undefined));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const outcome = await Promise.race([loading, timeout]);
    if (outcome === "timeout") {
      return {
        error: {
          status: 504,
          message: "This section did not answer in time.",
          details: { code: "timeout" },
        },
      };
    }
    return await toSectionResult(outcome);
  } catch (cause) {
    console.error("A project shell section failed.", {
      section: key,
      ...toSafeErrorLog(cause),
    });
    return { error: { status: 500, message: "Internal server error." } };
  } finally {
    clearTimeout(timer);
  }
}

async function toSectionResult(response: Response): Promise<SectionResult> {
  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    return { data: body };
  }

  const error = readErrorBody(body);
  return {
    error: {
      status: response.status,
      message: error?.message ?? "Request failed.",
      ...(error?.details !== undefined ? { details: error.details } : {}),
    },
  };
}

function readErrorBody(
  body: unknown,
): { message: string; details?: unknown } | null {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as { error: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const { message, details } = error as { message?: unknown; details?: unknown };
  return typeof message === "string" ? { message, details } : null;
}
