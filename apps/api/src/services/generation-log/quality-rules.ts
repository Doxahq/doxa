/**
 * What a failed docs quality rule means for a reader, by the rule id of the
 * agent validators. A rule that is not here reads as `UNKNOWN_RULE_TEXT`.
 */
const QUALITY_RULE_TEXT: Record<string, string> = {
  "empty-page": "the page is empty",
  tooShort: "the page is too short",
  "thin-collection-item-page": "the page is too short",
  "placeholder-content": "the page has placeholder text",
  "malformed-title": "the title has unbalanced punctuation",
  "mdx-parse": "the page has a formatting error",
  "end-tag-mismatch": "the page has a formatting error",
  "unknown-component": "the page uses a component that Doxa does not support",
  "validator-crashed": "the quality check could not run",
  "consumer-internal-path": "the page mentions internal paths or test files",
  "consumer-dev-script": "the page shows contributor scripts as user setup",
  "consumer-test-credential": "the page has demo credentials or debug defaults",
  "rest-endpoint-duplicate-section": "the page repeats a section",
  "unresolved-internal-link": "a link goes to a page that does not exist",
  "missing-generated-page": "a planned page is missing",
  "missing-rest-reference-page": "an API endpoint has no reference page",
  "missing-rest-reference-route": "an API endpoint has no reference page",
  "missing-sdk-reference-page": "an SDK export has no reference page",
  "missing-sdk-reference-route": "an SDK export has no reference page",
  "missing-collection-pages": "a collection has no pages",
  "missing-collection-item-page": "a collection item has no page",
  "missing-collection-item-route": "a collection item has no page",
  "collection-item-missing-install": "the install command is missing",
  "quickstart-too-long": "the quickstart is too long",
  "quickstart-undefined-shell-variable": "a shell variable in an example has no value",
  "quickstart-missing-import": "an example is missing an import",
  "quickstart-missing-canonical-install": "the install command is missing",
  "quickstart-ungrounded-install": "the install command does not match the project",
};

const UNKNOWN_RULE_TEXT = "a quality check failed";

export function qualityRuleText(rule: string): string {
  return QUALITY_RULE_TEXT[rule.trim()] ?? UNKNOWN_RULE_TEXT;
}
