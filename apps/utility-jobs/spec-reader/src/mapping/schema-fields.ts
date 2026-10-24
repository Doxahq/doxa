import { SPEC_READER_LIMITS, type SpecField } from "@doxahq/contracts/spec-reader";
import {
  arrayAt,
  isSpecObject,
  objectAt,
  stringAt,
  valueAt,
  type SpecObject,
  type SpecValue,
} from "../document/tree";
import type { Located, ReferenceResolver, Resolved } from "../references/resolver";
import { schemaExample } from "./examples";
import { schemaTypeLabel } from "./schema-types";
import { specName, specText } from "./text";

/**
 * Schema nodes that one flattening may visit. With the field budget and the
 * depth limit, this stops a small spec that would expand into millions of
 * fields through shared references.
 */
const MAX_VISITS = 20_000;
/** `allOf` parts nested inside `allOf` parts that still merge. */
const MAX_ALL_OF_DEPTH = 8;

interface ObjectView {
  /** Properties in merge order: `allOf` parts in their order, then the schema's own. */
  properties: Map<string, Located>;
  required: Set<string>;
}

/**
 * The flat field list of a request body or response schema. The walk is
 * depth first, in source order: object properties join with a dot, array
 * items add `[]`, and only leaves become fields. A schema that already
 * appears on the current branch stops there and shows its name. At most
 * 6 object levels and 500 fields.
 */
export function schemaFields(schema: Located, resolver: ReferenceResolver): SpecField[] {
  const walker = new FieldWalker(resolver);
  walker.walk(schema, "", { required: false, depth: 0, branch: new Set() });
  return walker.fields;
}

interface WalkState {
  required: boolean;
  /** Object levels above this node. */
  depth: number;
  /** Named schemas on the path from the root to this node. */
  branch: ReadonlySet<string>;
  /** The description of the property that holds this node. */
  description?: string;
}

class FieldWalker {
  readonly fields: SpecField[] = [];
  private visits = 0;

  constructor(private readonly resolver: ReferenceResolver) {}

  walk(schema: Located, name: string, state: WalkState): void {
    if (this.isFull()) return;
    this.visits += 1;

    const resolution = this.resolver.resolve(schema);
    if (!resolution.ok) return;
    const { resolved } = resolution;
    if (resolved.key && state.branch.has(resolved.key)) {
      return this.addField(name, resolved.name ?? "object", resolved, state);
    }
    const branch = resolved.key ? new Set([...state.branch, resolved.key]) : state.branch;
    const value = resolved.value;
    if (!isSpecObject(value)) return this.addField(name, "any", resolved, state);

    if (arrayAt(value, "oneOf") || arrayAt(value, "anyOf")) {
      return this.addField(name, schemaTypeLabel(resolved, this.resolver), resolved, state);
    }

    const items = valueAt(value, "items");
    if (items !== undefined && this.expandsToFields({ value: items, file: resolved.file })) {
      return this.walk({ value: items, file: resolved.file }, `${name}[]`, { ...state, branch });
    }

    const view = this.objectView(resolved, 0);
    if (!view || view.properties.size === 0) {
      return this.addField(name, schemaTypeLabel(resolved, this.resolver), resolved, state);
    }
    if (state.depth >= SPEC_READER_LIMITS.maxSchemaDepth) {
      return this.addField(name, resolved.name ?? "object", resolved, state);
    }
    for (const [property, propertySchema] of view.properties) {
      this.walk(propertySchema, name ? `${name}.${property}` : property, {
        required: view.required.has(property),
        depth: state.depth + 1,
        branch,
        description: propertyDescription(propertySchema),
      });
    }
  }

  /** True when the items of an array are objects with properties, so they get their own fields. */
  private expandsToFields(items: Located): boolean {
    const resolution = this.resolver.resolve(items);
    if (!resolution.ok || !isSpecObject(resolution.resolved.value)) return false;
    const view = this.objectView(resolution.resolved, 0);
    return Boolean(view && view.properties.size > 0);
  }

  /** The merged properties of a schema and its `allOf` parts. Later parts win a name. */
  private objectView(schema: Resolved, allOfDepth: number): ObjectView | undefined {
    if (!isSpecObject(schema.value) || allOfDepth > MAX_ALL_OF_DEPTH) return undefined;
    const value = schema.value;
    const parts = arrayAt(value, "allOf") ?? [];
    const own = objectAt(value, "properties");
    if (parts.length === 0 && !own) return undefined;

    const view: ObjectView = { properties: new Map(), required: new Set() };
    for (const part of parts) {
      const resolution = this.resolver.resolve({ value: part, file: schema.file });
      if (!resolution.ok) continue;
      const partView = this.objectView(resolution.resolved, allOfDepth + 1);
      if (!partView) continue;
      for (const [name, property] of partView.properties) view.properties.set(name, property);
      for (const name of partView.required) view.required.add(name);
    }
    for (const [key, property] of Object.entries(own ?? {})) {
      const name = specName(key);
      if (name) view.properties.set(name, { value: property, file: schema.file });
    }
    for (const required of arrayAt(value, "required") ?? []) {
      if (typeof required === "string") view.required.add(required);
    }
    return view;
  }

  private addField(name: string, type: string, schema: Resolved, state: WalkState): void {
    // The root of a body is not a field; only its properties are.
    if (!name || this.isFull()) return;
    const value: SpecObject | undefined = isSpecObject(schema.value) ? schema.value : undefined;
    const field: SpecField = { name, type, required: state.required };
    const description = specText(
      state.description ?? schema.description ?? (value && stringAt(value, "description")),
      SPEC_READER_LIMITS.maxFieldDescriptionChars,
    );
    if (description) field.description = description;
    const example = value ? schemaExample(value) : undefined;
    if (example !== undefined) field.example = example;
    this.fields.push(field);
  }

  private isFull(): boolean {
    return this.fields.length >= SPEC_READER_LIMITS.maxSchemaFields || this.visits >= MAX_VISITS;
  }
}

/** The description written on a property, which wins over the description of its schema. */
function propertyDescription(property: Located): string | undefined {
  const value: SpecValue = property.value;
  return isSpecObject(value) ? stringAt(value, "description") : undefined;
}
