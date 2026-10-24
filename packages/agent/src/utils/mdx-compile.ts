/**
 * MDX compile wrapper.
 *
 * Spawns the package's Node MDX validator as an isolated subprocess, pipes the page
 * content through stdin, and parses the JSON report from stdout. Subprocess
 * isolation keeps the parent process safe from `@mdx-js/mdx` crashes and
 * makes the validator easy to swap out (e.g. for a different toolchain).
 *
 * Fail-closed contract: any subprocess failure (timeout, non-zero exit,
 * non-JSON stdout, missing script) returns `ok: false` with a single
 * `validator-crashed` error. Silent passes are never produced — the writer
 * gate must be able to trust an `ok: true` response unconditionally.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./runtime";
import { emitAgentSpan } from "../core/span";
import type { AgentSpanCallback } from "../core/types";
import {
  getSharedMdxValidatorPool,
  resolveMdxValidatorServerPath,
  type MdxValidatorPool,
} from "./mdx-validator-pool";

export interface MdxCompileError {
  rule: string;
  severity: "hard";
  line: number;
  col: number;
  message: string;
  snippet: string;
}

export interface MdxCompileResult {
  ok: boolean;
  errors: MdxCompileError[];
}

export interface MdxCompileOptions {
  /** Subprocess timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /**
   * Override the validator script path. Tests use this to exercise the
   * fail-closed path; production callers should leave it unset.
   */
  scriptPath?: string;
  /** Receives fail-closed validator timing without affecting validation. */
  onSpan?: AgentSpanCallback;
  /** Test-only runtime seams for deterministic pool-failure coverage. */
  runtime?: {
    pool?: MdxValidatorPool;
    compileOneShot?: (
      content: string,
      opts: MdxCompileOptions,
    ) => Promise<MdxCompileResult>;
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;
const VALIDATOR_REL_PATH = join("runtime", "mdx-validator.mjs");

function resolveScriptPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, VALIDATOR_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function crashed(message: string): MdxCompileResult {
  return {
    ok: false,
    errors: [
      {
        rule: "validator-crashed",
        severity: "hard",
        line: 0,
        col: 0,
        message,
        snippet: "",
      },
    ],
  };
}

function isMdxError(value: unknown): value is MdxCompileError {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.rule === "string" &&
    typeof v.message === "string" &&
    typeof v.line === "number" &&
    typeof v.col === "number"
  );
}

function parseReport(stdout: string): MdxCompileResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok === true) return { ok: true, errors: [] };
  if (obj.ok === false && Array.isArray(obj.errors)) {
    const errors: MdxCompileError[] = [];
    for (const e of obj.errors) {
      if (!isMdxError(e)) return null;
      errors.push({
        rule: e.rule,
        severity: "hard",
        line: e.line,
        col: e.col,
        message: e.message,
        snippet: typeof e.snippet === "string" ? e.snippet : "",
      });
    }
    return { ok: false, errors };
  }
  return null;
}

export async function compileMdx(
  content: string,
  opts: MdxCompileOptions = {},
): Promise<MdxCompileResult> {
  const startedAt = Date.now();
  const finish = async (
    result: MdxCompileResult,
  ): Promise<MdxCompileResult> => {
    const endedAt = Date.now();
    await emitAgentSpan(opts.onSpan, {
      kind: "validation",
      name: "mdx_compile",
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ok: result.ok,
    });
    return result;
  };
  const result = await compileMdxInternal(content, opts);
  return finish(result);
}

async function compileMdxInternal(
  content: string,
  opts: MdxCompileOptions,
): Promise<MdxCompileResult> {
  const pool = resolveValidatorPool(opts);
  if (pool) {
    if (!pool.isAvailable()) {
      return compileMdxOneShotWithRuntime(content, opts);
    }
    const pooledResult = await pool.compile(content);
    if (!hasValidatorCrash(pooledResult) || pool.isAvailable()) {
      return pooledResult;
    }
  }

  return compileMdxOneShotWithRuntime(content, opts);
}

function compileMdxOneShotWithRuntime(
  content: string,
  opts: MdxCompileOptions,
): Promise<MdxCompileResult> {
  return opts.runtime?.compileOneShot?.(content, opts) ??
    compileMdxOneShot(content, opts);
}

async function compileMdxOneShot(
  content: string,
  opts: MdxCompileOptions,
): Promise<MdxCompileResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scriptPath = opts.scriptPath ?? resolveScriptPath();
  if (!scriptPath) {
    return crashed(
      `Could not locate ${VALIDATOR_REL_PATH} relative to the @doxahq/agent runtime. ` +
        "Ensure the package runtime directory ships alongside dist.",
    );
  }
  if (!existsSync(scriptPath)) {
    return crashed(`Validator script not found at ${scriptPath}`);
  }

  let result;
  try {
    result = await runCommand([process.execPath, scriptPath], {
      stdin: content,
      timeoutMs,
    });
  } catch (err) {
    return crashed(
      `Failed to spawn mdx validator: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (result.timedOut) {
    return crashed(`MDX validator timed out after ${timeoutMs}ms`);
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    const stderr = result.stderr.trim();
    return crashed(
      `MDX validator exited (code ${result.exitCode}) without stdout. stderr: ${stderr || "(empty)"}`,
    );
  }

  const report = parseReport(stdout);
  if (!report) {
    return crashed(
      `MDX validator returned malformed JSON: ${stdout.slice(0, 200)}`,
    );
  }
  return report;
}

export async function assertMdxValidatorReady(
  opts: MdxCompileOptions = {},
): Promise<void> {
  if (canUseSharedPool(opts) && resolveMdxValidatorServerPath()) {
    try {
      await getSharedMdxValidatorPool().warm();
      return;
    } catch (error) {
      throw new Error(
        `MDX validator startup check failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const result = await compileMdx("# Doxa MDX validator readiness\n", opts);
  if (result.ok) return;

  const detail = result.errors.map((error) => error.message).join("; ");
  throw new Error(`MDX validator startup check failed: ${detail || "unknown validator failure"}`);
}

function hasValidatorCrash(result: MdxCompileResult): boolean {
  return result.errors.some((error) => error.rule === "validator-crashed");
}

function resolveValidatorPool(
  opts: MdxCompileOptions,
): MdxValidatorPool | undefined {
  if (opts.runtime?.pool) return opts.runtime.pool;
  if (canUseSharedPool(opts) && resolveMdxValidatorServerPath()) {
    return getSharedMdxValidatorPool();
  }
  return undefined;
}

function canUseSharedPool(opts: MdxCompileOptions): boolean {
  return !opts.scriptPath &&
    (opts.timeoutMs === undefined || opts.timeoutMs === DEFAULT_TIMEOUT_MS);
}
