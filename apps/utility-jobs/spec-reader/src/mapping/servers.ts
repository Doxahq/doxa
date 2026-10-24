import { SPEC_READER_LIMITS, type SpecServer } from "@doxahq/contracts/spec-reader";
import { arrayAt, isSpecObject, objectAt, stringAt, type SpecObject } from "../document/tree";
import { hasControlCharacter, specText } from "./text";

/** Servers that a spec lists; the rest are left out. */
const MAX_SERVERS = 20;

/**
 * The root `servers`, with every `{variable}` replaced by its default.
 * The agent container decides later which URL a page may show or call.
 */
export function readServers(root: SpecObject): SpecServer[] {
  return (arrayAt(root, "servers") ?? []).slice(0, MAX_SERVERS).flatMap((entry) => {
    if (!isSpecObject(entry)) return [];
    const template = stringAt(entry, "url")?.trim();
    if (!template) return [];
    const url = substituteVariables(template, objectAt(entry, "variables"));
    if (url.length > SPEC_READER_LIMITS.maxPathChars || hasControlCharacter(url) || /\s/.test(url)) return [];
    const server: SpecServer = { url };
    const description = specText(stringAt(entry, "description"), SPEC_READER_LIMITS.maxTitleChars);
    if (description) server.description = description;
    return [server];
  });
}

function substituteVariables(template: string, variables: SpecObject | undefined): string {
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const variable = variables ? objectAt(variables, name) : undefined;
    const defaultValue = variable ? stringAt(variable, "default") : undefined;
    return defaultValue ?? match;
  });
}
