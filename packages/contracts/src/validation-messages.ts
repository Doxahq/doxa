import type { ValidationIssue, ValidationIssueCode } from "./validation";

type Params = NonNullable<ValidationIssue["params"]>;
const messages = {
  invalid_color: () =>
    "This color is not valid. Use a hex, RGB, HSL, OKLCH, or OKLAB color with bounded numbers.",
  invalid_length: () => "This length is not valid. Use 0, 0–4rem, or 0–64px.",
  unknown_font: () =>
    "This font is not available. Choose a font from the list.",
  invalid_href: () =>
    "This link is not valid. Use a link that starts with https://, http://, mailto:, or /.",
  unsafe_href_protocol: () =>
    "This link uses an unsupported protocol. Use a permitted link protocol.",
  invalid_asset_ref: () =>
    "This asset reference is not valid. Select an uploaded asset.",
  too_long: (params) =>
    `This text is too long. Use ${params.max} characters or fewer.`,
  invalid_text: () =>
    "This text contains control characters. Remove the control characters.",
  too_many_items: (params) =>
    `This list has too many items. Use ${params.max} items or fewer.`,
  unknown_key: () =>
    "This setting is not recognized. Remove it or correct its name.",
  required: () => "This value is required. Enter a value.",
  invalid_type: () =>
    "This value has the wrong type. Use the type shown in the schema.",
  unknown_preset: () =>
    "This theme preset is not available. Choose a preset from the list.",
  config_too_large: (params) =>
    `These settings exceed the size limit. Reduce the JSON to ${params.max ?? 65536} bytes or fewer.`,
  too_deep: () =>
    "These settings have too many nested levels. Use no more than 8 levels.",
  link_target_not_found: () =>
    "This link does not match a documentation page. Check the page path.",
  duplicate_link: () =>
    "This link appears more than once in this list. Check whether the duplicate is needed.",
  entitlement_required: () =>
    "Only paid plans can hide 'Powered by Doxa'. Upgrade the plan to hide it.",
  asset_not_found: () =>
    "This asset is not available for this site. Upload or select an asset for this project.",
  asset_wrong_kind: () =>
    "This asset has the wrong kind. Select an asset for this field.",
  asset_unsupported_type: () =>
    "This file type is not supported. Use PNG, JPEG, WebP, ICO, or SVG.",
  asset_too_large: (params) =>
    `This asset exceeds the size limit. Use ${params.max} bytes or fewer.`,
  asset_sanitized: () =>
    "Doxa removed unsafe parts from this SVG. Check the preview.",
  invalid_json: () => "This JSON is not valid. Correct the JSON syntax.",
  low_contrast: () =>
    "These colors have low contrast. Choose colors with a contrast ratio of at least 4.5.",
  invalid_theme_file: () =>
    "This theme file is not valid. Use the theme schema and a file of 32 KiB or less.",
  invalid_branch_name: () =>
    "This branch name is not valid. Use 1 to 40 lowercase letters, digits, or internal hyphens.",
  reserved_branch_name: () =>
    "This branch name is reserved. Choose a different name.",
  branch_name_taken: () =>
    "This branch name is in use. Choose a different name.",
  branch_limit_reached: (params) =>
    `This site has reached its branch limit. Erase a branch to stay under ${params.max ?? 10} branches.`,
  too_many_changes: () =>
    "This branch has too many changed files. Use 2,000 files or fewer.",
  branch_too_large: () =>
    "This branch has too much content. Use 32 MiB or less.",
  structure_missing_page: () =>
    "The site structure names a missing page. Restore the page or remove its link.",
  structure_invalid: () =>
    "The site structure is not valid. Keep exactly one default section.",
  orphan_page: () =>
    "This page is absent from the site structure. Add it to the navigation or remove it.",
  mdx_invalid: (params) =>
    `This page is not valid MDX${formatSourcePosition(params)}: ${params.reason ?? "the parser rejected it"}. Fix the syntax or use a supported component.`,
} satisfies Record<ValidationIssueCode, (params: Params) => string>;

function formatSourcePosition(params: Params): string {
  if (params.line === undefined) return "";
  if (params.column === undefined) return ` at line ${params.line}`;
  return ` at line ${params.line}, column ${params.column}`;
}

export function formatIssueMessage(
  code: ValidationIssueCode,
  params: Params = {},
): string {
  return messages[code](params);
}

export function createValidationIssue(
  code: ValidationIssueCode,
  path = "",
  params?: Params,
  severity: ValidationIssue["severity"] = "error",
): ValidationIssue {
  return {
    code,
    path,
    severity,
    message: formatIssueMessage(code, params),
    ...(params ? { params } : {}),
  };
}
