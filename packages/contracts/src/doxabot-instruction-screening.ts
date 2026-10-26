import type {
  DoxabotInstructionFlag,
  DoxabotInstructionScreening,
  DoxabotInstructions,
} from "./doxabot-instructions";

/**
 * Finds free text that asks Doxabot for more than style or content: to drop
 * its rules, reveal secrets, run commands or send data somewhere.
 *
 * The check is a cheap first pass. A flagged item still saves, but never
 * reaches the prompt. The real protection is that Doxabot has no tool that
 * could do these things.
 */

const OUT_OF_SCOPE_PATTERNS: readonly RegExp[] = [
  // "ignore all previous instructions", "disregard the rules above"
  /\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|any|other|system|your)\b.{0,24}\b(instructions?|rules?|prompts?|policy|policies|guidelines?)\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\byou are (now|no longer)\b/i,
  // secret files and values
  /(^|[\s"'`(])\.env\b/i,
  /\b(environment variables?|env vars?|process\.env)\b/i,
  /\b(contents?|values?)\s+of\b.{0,40}\b(secrets?|credentials?|tokens?|keys?|passwords?)\b/i,
  // commands and network calls
  /\b(run|execute|exec)\b.{0,30}\b(commands?|shell|bash|scripts?|curl|wget)\b/i,
  /\b(send|post|upload|exfiltrate|forward)\b.{0,40}\b(to|at)\b.{0,20}https?:\/\//i,
];

export function isOutOfScopeInstructionText(text: string): boolean {
  return OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(text));
}

export function screenDoxabotInstructions(
  instructions: Pick<DoxabotInstructions, "rules" | "context">,
): DoxabotInstructionScreening {
  const flags: DoxabotInstructionFlag[] = instructions.rules.flatMap((rule, index) =>
    isOutOfScopeInstructionText(rule) ? [{ field: "rules" as const, index }] : []
  );
  if (isOutOfScopeInstructionText(instructions.context)) {
    flags.push({ field: "context", index: null });
  }
  return { method: "heuristic", flags };
}

export function isRuleFlagged(screening: DoxabotInstructionScreening, index: number): boolean {
  return screening.flags.some((flag) => flag.field === "rules" && flag.index === index);
}

export function isContextFlagged(screening: DoxabotInstructionScreening): boolean {
  return screening.flags.some((flag) => flag.field === "context");
}
