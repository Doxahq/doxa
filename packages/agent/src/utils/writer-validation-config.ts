/**
 * Writer validation config resolution.
 *
 * Resolves a {@link WriterValidationConfig} from explicit overrides, env
 * variables, then defaults. Callers that already accept CLI flags should
 * forward parsed values via the `overrides` arg — env is only consulted when
 * the corresponding override is undefined.
 *
 * Recognized env variables:
 *   - `DOXA_WRITER_MAX_ATTEMPTS`     — positive integer; default 3.
 *   - `DOXA_WRITER_MDX_COMPILE`      — `0`/`false` disables the MDX pass.
 *   - `DOXA_WRITER_MDX_TIMEOUT_MS`   — positive integer ms; default 10000.
 */

import {
  DEFAULT_WRITER_VALIDATION,
  type WriterValidationConfig,
} from "../types";

export interface WriterValidationOverrides {
  maxAttempts?: number;
  mdxCompile?: boolean;
  timeoutMs?: number;
  targetedRepairClasses?: WriterValidationConfig["targetedRepairClasses"];
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return undefined;
}

export function resolveWriterValidation(
  overrides: WriterValidationOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): WriterValidationConfig {
  const envMaxAttempts = parsePositiveInt(env.DOXA_WRITER_MAX_ATTEMPTS);
  const envMdxCompile = parseBooleanFlag(env.DOXA_WRITER_MDX_COMPILE);
  const envTimeoutMs = parsePositiveInt(env.DOXA_WRITER_MDX_TIMEOUT_MS);

  return {
    maxAttempts:
      overrides.maxAttempts ?? envMaxAttempts ?? DEFAULT_WRITER_VALIDATION.maxAttempts,
    mdxCompile:
      overrides.mdxCompile ?? envMdxCompile ?? DEFAULT_WRITER_VALIDATION.mdxCompile,
    timeoutMs:
      overrides.timeoutMs ?? envTimeoutMs ?? DEFAULT_WRITER_VALIDATION.timeoutMs,
    targetedRepairClasses:
      overrides.targetedRepairClasses ??
      DEFAULT_WRITER_VALIDATION.targetedRepairClasses,
  };
}
