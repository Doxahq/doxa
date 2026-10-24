import { createValidationIssue } from "@doxahq/contracts/validation-messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AccessDeniedError,
  HintedToolError,
  mapToolError,
  MdxInvalidError,
  MissingToolScopeError,
  ToolNotFoundError,
  ToolRateLimitedError,
  type ToolErrorCode,
} from "../src/errors";
import { CreateCustomDocsDomainError } from "@doxahq/api/repositories/docs-domains";
import { ActiveGenerationConflictError } from "@doxahq/api/repositories/jobs";
import { ProjectDeletionError } from "@doxahq/api/repositories/project-deletion";
import { CreateProjectError } from "@doxahq/api/repositories/projects";
import { DocsBranchValidationError } from "@doxahq/api/services/docs-branches/management";
import { SyncValidationError } from "@doxahq/api/services/docs-branches/sync";
import {
  DocsContentError,
  type DocsContentErrorCode,
} from "@doxahq/api/services/docs-content/errors";
import { DocsDomainProvisioningError } from "@doxahq/api/services/docs-domain-lifecycle";
import { SiteConfigValidationError } from "@doxahq/api/services/site-config-validation";

const REQUEST_ID = "request-1";
const ISSUE = createValidationIssue("invalid_branch_name", "/name");

const ROWS: Array<{ label: string; error: unknown; code: ToolErrorCode }> = [
  {
    label: "access not_found",
    error: new AccessDeniedError("not_found"),
    code: "not_found",
  },
  {
    label: "access scope_missing",
    error: new AccessDeniedError("scope_missing"),
    code: "scope_missing",
  },
  {
    label: "access project_not_in_grant",
    error: new AccessDeniedError("project_not_in_grant"),
    code: "project_not_in_grant",
  },
  {
    label: "access forbidden",
    error: new AccessDeniedError("forbidden"),
    code: "forbidden",
  },
  {
    label: "record not found",
    error: new ToolNotFoundError("Generation"),
    code: "not_found",
  },
  {
    label: "runner scope",
    error: new MissingToolScopeError("docs:read"),
    code: "insufficient_scope",
  },
  {
    label: "rate limit",
    error: new ToolRateLimitedError(),
    code: "rate_limited",
  },
  {
    label: "site config",
    error: new SiteConfigValidationError([ISSUE]),
    code: "validation_failed",
  },
  {
    label: "branch validation",
    error: new DocsBranchValidationError([ISSUE]),
    code: "validation_failed",
  },
  {
    label: "sync validation",
    error: new SyncValidationError([ISSUE]),
    code: "validation_failed",
  },
  { label: "mdx", error: new MdxInvalidError([ISSUE]), code: "mdx_invalid" },
  {
    label: "create project",
    error: new CreateProjectError("slug_unavailable", "Taken."),
    code: "slug_unavailable",
  },
  {
    label: "delete project",
    error: new ProjectDeletionError("generation_active", "Busy."),
    code: "generation_active",
  },
  {
    label: "custom domain",
    error: new CreateCustomDocsDomainError("hostname_taken"),
    code: "hostname_taken",
  },
  {
    label: "domain provider",
    error: new DocsDomainProvisioningError("Cloudflare failed."),
    code: "domain_provider_error",
  },
  {
    label: "active generation",
    error: new ActiveGenerationConflictError(),
    code: "generation_active",
  },
  {
    label: "unknown error",
    error: new Error("database password is hunter2"),
    code: "internal_error",
  },
  { label: "non-error throw", error: "boom", code: "internal_error" },
];

const DOCS_CONTENT_CODES: DocsContentErrorCode[] = [
  "not_found",
  "conflict",
  "invalid",
  "no_changes",
  "branch_not_found",
  "branch_behind",
  "main_changed",
  "conflicts_unresolved",
  "preview_rate_limited",
];

describe("mapToolError", () => {
  it.each(ROWS)("maps $label to $code", ({ error, code }) => {
    const body = mapToolError(error, REQUEST_ID);
    expect(body.code).toBe(code);
    expect(body.requestId).toBe(REQUEST_ID);
    expect(body.message.length).toBeGreaterThan(0);
  });

  it.each(DOCS_CONTENT_CODES)("keeps the DocsContentError code %s", (code) => {
    expect(
      mapToolError(new DocsContentError(code, "Message."), REQUEST_ID).code,
    ).toBe(code);
  });

  it("returns the current revision of a conflict as a detail", () => {
    const body = mapToolError(
      new DocsContentError("conflict", "Stale.", {
        currentRevision: 7,
        nested: { x: 1 },
      }),
      REQUEST_ID,
    );
    expect(body.details).toEqual({ currentRevision: 7 });
    expect(body.hint).toMatch(/revision/);
  });

  it("passes validation issues through", () => {
    expect(
      mapToolError(new SiteConfigValidationError([ISSUE]), REQUEST_ID).issues,
    ).toEqual([ISSUE]);
  });

  it("keeps the wrapped error's code and issues but replaces its hint", () => {
    const body = mapToolError(
      new HintedToolError(
        new DocsBranchValidationError([ISSUE]),
        "Existing branches: agent-a.",
      ),
      REQUEST_ID,
    );
    expect(body).toMatchObject({
      code: "validation_failed",
      hint: "Existing branches: agent-a.",
      issues: [ISSUE],
    });
  });

  it("gives retryAfterSeconds for a rate limit", () => {
    expect(
      mapToolError(new ToolRateLimitedError(), REQUEST_ID).details,
    ).toEqual({
      retryAfterSeconds: 60,
    });
  });

  it("never returns the message or stack of an unknown error", () => {
    const body = mapToolError(
      new Error("database password is hunter2"),
      REQUEST_ID,
    );
    expect(JSON.stringify(body)).not.toMatch(/hunter2|at /);
  });

  it("produces bodies that serialize to plain JSON", () => {
    const bodySchema = z
      .object({
        code: z.string(),
        message: z.string(),
        hint: z.string().optional(),
        issues: z.array(z.unknown()).optional(),
        details: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional(),
        requestId: z.string(),
      })
      .strict();
    for (const { error } of ROWS) {
      expect(() =>
        bodySchema.parse(
          JSON.parse(JSON.stringify(mapToolError(error, REQUEST_ID))),
        ),
      ).not.toThrow();
    }
  });
});
