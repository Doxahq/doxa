import { SPEC_READER_LIMITS, type SpecTag } from "@doxahq/contracts/spec-reader";
import { arrayAt, isSpecObject, stringAt, type SpecObject } from "../document/tree";
import { specName, specText } from "./text";

interface DeclaredTag extends SpecTag {
  parent?: string;
}

/**
 * The tags of a spec in group order: the root `tags` list, then tags that
 * operations use first. A 3.2 child tag (`parent`) follows its parent.
 * Undefined when the spec has more tags than the D9 ceiling.
 */
export function orderTags(root: SpecObject, usedTags: readonly string[]): SpecTag[] | undefined {
  const declared = new Map<string, DeclaredTag>();
  for (const entry of arrayAt(root, "tags") ?? []) {
    const tag = isSpecObject(entry) ? readTag(entry) : undefined;
    if (tag && !declared.has(tag.name)) declared.set(tag.name, tag);
    if (declared.size > SPEC_READER_LIMITS.maxTags) return undefined;
  }
  for (const name of usedTags) {
    if (!declared.has(name)) declared.set(name, { name });
    if (declared.size > SPEC_READER_LIMITS.maxTags) return undefined;
  }
  return withChildrenAfterParents([...declared.values()]);
}

function readTag(tag: SpecObject): DeclaredTag | undefined {
  const name = specName(stringAt(tag, "name"));
  if (!name) return undefined;
  const result: DeclaredTag = { name };
  const displayName = specText(stringAt(tag, "summary") ?? stringAt(tag, "x-displayName"), SPEC_READER_LIMITS.maxTitleChars);
  if (displayName) result.displayName = displayName;
  const description = specText(stringAt(tag, "description"), SPEC_READER_LIMITS.maxDescriptionChars);
  if (description) result.description = description;
  const parent = specName(stringAt(tag, "parent"));
  if (parent && parent !== name) result.parent = parent;
  return result;
}

function toSpecTag(tag: DeclaredTag): SpecTag {
  const result: SpecTag = { name: tag.name };
  if (tag.displayName) result.displayName = tag.displayName;
  if (tag.description) result.description = tag.description;
  return result;
}

/** Keeps the order, but moves each child tag right after its parent and its earlier children. */
function withChildrenAfterParents(tags: readonly DeclaredTag[]): SpecTag[] {
  const names = new Set(tags.map((tag) => tag.name));
  const children = new Map<string, DeclaredTag[]>();
  for (const tag of tags) {
    if (tag.parent && names.has(tag.parent)) {
      children.set(tag.parent, [...(children.get(tag.parent) ?? []), tag]);
    }
  }

  const ordered: SpecTag[] = [];
  const placed = new Set<string>();
  const place = (tag: DeclaredTag): void => {
    if (placed.has(tag.name)) return;
    placed.add(tag.name);
    ordered.push(toSpecTag(tag));
    for (const child of children.get(tag.name) ?? []) place(child);
  };
  for (const tag of tags) {
    if (!tag.parent || !names.has(tag.parent)) place(tag);
  }
  // Tags in a parent cycle have no root; they keep their own order.
  for (const tag of tags) place(tag);
  return ordered;
}
