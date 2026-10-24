import type { z } from "zod";
import {
  validationIssueCodeSchema,
  type ValidationIssue,
} from "@doxahq/contracts/validation";
import { createValidationIssue } from "@doxahq/contracts/validation-messages";
import { toJsonPointer, valueAtPath } from "./pointer";

export function toValidationIssues(
  error: z.ZodError,
  input?: unknown,
): ValidationIssue[] {
  return error.issues.flatMap((issue) => {
    const path = toJsonPointer(issue.path);
    switch (issue.code) {
      case "unrecognized_keys":
        return issue.keys.map((key) =>
          createValidationIssue(
            "unknown_key",
            toJsonPointer([...issue.path, key]),
          ),
        );
      case "custom": {
        const code = validationIssueCodeSchema.safeParse(
          issue.params?.siteConfigCode,
        );
        if (code.success) return [createValidationIssue(code.data, path)];
        break;
      }
      case "invalid_type":
        return [
          createValidationIssue(
            valueAtPath(input, issue.path) === undefined
              ? "required"
              : "invalid_type",
            path,
          ),
        ];
      case "too_small":
        // Non-empty text is the only minimum in the schema. Any other
        // minimum has no code yet and takes the fallback below.
        if (issue.origin === "string" && Number(issue.minimum) === 1)
          return [createValidationIssue("required", path)];
        break;
      case "too_big":
        return [
          createValidationIssue(
            issue.origin === "array" ? "too_many_items" : "too_long",
            path,
            { max: Number(issue.maximum) },
          ),
        ];
      case "invalid_value":
        return [
          createValidationIssue(
            issue.path.includes("fonts")
              ? "unknown_font"
              : issue.path.at(-1) === "preset"
                ? "unknown_preset"
                : "invalid_type",
            path,
          ),
        ];
    }
    return [
      {
        ...createValidationIssue("invalid_type", path),
        message: issue.message.slice(0, 300),
      },
    ];
  });
}
