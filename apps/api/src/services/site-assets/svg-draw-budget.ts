import {
  LOCAL_HREF,
  LOCAL_URL,
  childElements,
  type KeptAttribute,
  type PlannedElement,
  type SvgPlan,
} from "./svg-plan";

/**
 * The reference rules of the SVG cleaner. Some references make a browser
 * draw other content again: `<use>` clones its target, a marker draws at
 * vertices, and a pattern, clip path, or mask draws its content for each
 * element that uses it. Chains of them multiply, so a small file could ask
 * for billions of draws. These rules bound the total.
 *
 * - The cost of an element is the number of nodes that one draw of it
 *   draws, with every reference below it expanded. It is computed once per
 *   element over the reference graph, so the work stays linear.
 * - A reference points at an ID, not at one element. Several elements can
 *   share an ID, and a browser draws the first of them that is in the
 *   output, which can be a later one when the rules cut the first. So the
 *   cost of an ID is the highest cost of its elements. Each ID is one node
 *   of the graph, so shared IDs add no work per reference.
 * - A reference that is part of a cycle is cut. Browsers draw nothing for
 *   it either.
 * - In document order, each reference may add its copies times the cost of
 *   its target while the total stays within `MAX_DRAWN_BY_REFERENCES`. A
 *   reference that does not fit is cut.
 * - `fill`, `stroke`, and the marker properties inherit. A pattern or marker
 *   reference stays only on a shape or text element with no content below it
 *   other than text, so it never reaches content that is drawn elsewhere.
 * - Marker content can paint with `context-fill` or `context-stroke`, the
 *   paint of the element that draws the marker. So each marker copy also
 *   costs that element's pattern paint.
 *
 * A cut `<use>` is left out; any other cut reference loses its attribute.
 */

/**
 * Nodes that references may make a browser draw in total. A 2 MB file can
 * hold far more nodes than this as plain content, so the limit adds little
 * work. Real diagrams stay far below it.
 */
export const MAX_DRAWN_BY_REFERENCES = 20_000;
/** Costs stop growing here: past the limit, every value means "too much". */
const COST_CAP = MAX_DRAWN_BY_REFERENCES + 1;

type ReferenceKind = "use" | "pattern_template" | "clip" | "mask" | "paint" | "marker";

/** The elements that `#id` can resolve to, for a reference that needs `tag`. */
interface IdTarget {
  candidates: readonly PlannedElement[];
}

/** A node of the cost graph: an element, or an ID that references point at. */
type CostNode = PlannedElement | IdTarget;

interface DrawReference {
  owner: PlannedElement;
  attribute: KeptAttribute;
  kind: ReferenceKind;
  target: IdTarget;
  /** Draws of the target per draw of the owner: an upper bound. */
  copies: number;
  /** Nodes it adds per draw of the owner. Set once the costs are known. */
  drawn: number;
  cut: boolean;
}

const PAINT_HOSTS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
]);
const MARKER_HOSTS = new Set(["path", "line", "polyline", "polygon"]);
/** What a host may hold: text runs and labels, never content drawn elsewhere. */
const HOST_CONTENT = new Set(["tspan", "textPath", "title", "desc"]);
const MARKER_PROPERTIES = new Set(["marker-start", "marker-mid", "marker-end"]);
const PATH_NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/g;
const PATH_COMMAND = /[MLHVCSQTAZmlhvcsqtaz]/g;
const SUBPATH_COMMAND = /[MmZz]/g;

/** Applies the reference rules to `plan`. Returns the number of cut references. */
export function applyDrawBudget(plan: SvgPlan): number {
  const shapes = subtreeShapes(plan.elements);
  const collected = collectReferences(plan, shapes);
  const byOwner = groupByOwner(collected.references);
  drawCosts(plan.elements, byOwner);
  cutOverBudget(collected.references);
  return collected.removed + applyCuts(collected.references);
}

interface SubtreeShape {
  /** The element and its kept descendants. */
  size: number;
  /** Every descendant element is in `HOST_CONTENT`. */
  hostable: boolean;
}

/** Children come after their parents in document order, so a reverse walk sums up. */
function subtreeShapes(elements: readonly PlannedElement[]): Map<PlannedElement, SubtreeShape> {
  const shapes = new Map<PlannedElement, SubtreeShape>();
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index];
    if (!element) continue;
    let size = 1;
    let hostable = true;
    for (const child of childElements(element)) {
      const shape = shapes.get(child);
      size += shape?.size ?? 1;
      hostable &&= HOST_CONTENT.has(child.tagName) && (shape?.hostable ?? true);
    }
    shapes.set(element, { size, hostable });
  }
  return shapes;
}

/** The references of every element, in document order, then attribute order. */
function collectReferences(
  plan: SvgPlan,
  shapes: ReadonlyMap<PlannedElement, SubtreeShape>,
): { references: DrawReference[]; removed: number } {
  const references: DrawReference[] = [];
  const targets = new IdTargets(plan.byId);
  let removed = 0;
  for (const owner of plan.elements) {
    const shape = shapes.get(owner) ?? { size: 1, hostable: true };
    for (const attribute of owner.attributes) {
      if (attribute.dropped) continue;
      const reference = referenceOf(owner, attribute);
      if (!reference) continue;
      const found = targetIds(attribute).flatMap((id) => {
        const target = targets.get(id, reference.targetTag);
        return target ? [target] : [];
      });
      if (found.length === 0) continue;
      if (isInherited(reference.kind) && !isHost(owner, reference.kind, shape)) {
        attribute.dropped = true;
        removed++;
        continue;
      }
      const copies = copiesOf(owner, attribute, reference.kind, shape);
      for (const target of found) {
        const { kind } = reference;
        references.push({ owner, attribute, kind, target, copies, drawn: 0, cut: false });
      }
    }
  }
  return { references, removed };
}

/** One shared node per ID and target tag, so a shared ID costs no work per reference. */
class IdTargets {
  private readonly targets = new Map<string, IdTarget | null>();

  constructor(private readonly byId: ReadonlyMap<string, readonly PlannedElement[]>) {}

  get(id: string, tag: string | null): IdTarget | null {
    const key = `${tag ?? "*"} ${id}`;
    const known = this.targets.get(key);
    if (known !== undefined) return known;
    const candidates = (this.byId.get(id) ?? []).filter(
      (element) => tag === null || element.tagName === tag,
    );
    const target = candidates.length > 0 ? { candidates } : null;
    this.targets.set(key, target);
    return target;
  }
}

/**
 * What a reference in `attribute` draws, and the element type it needs.
 * Gradients draw no content, so a paint reference counts only a pattern.
 */
function referenceOf(
  owner: PlannedElement,
  attribute: KeptAttribute,
): { kind: ReferenceKind; targetTag: string | null } | null {
  if (isHref(attribute)) {
    if (owner.tagName === "use") return { kind: "use", targetTag: null };
    if (owner.tagName === "pattern") return { kind: "pattern_template", targetTag: "pattern" };
    return null;
  }
  if (attribute.name === "clip-path") return { kind: "clip", targetTag: "clipPath" };
  if (attribute.name === "mask") return { kind: "mask", targetTag: "mask" };
  if (attribute.name === "fill" || attribute.name === "stroke") {
    return { kind: "paint", targetTag: "pattern" };
  }
  if (MARKER_PROPERTIES.has(attribute.name)) return { kind: "marker", targetTag: "marker" };
  return null;
}

function isHref(attribute: KeptAttribute): boolean {
  return attribute.name === "href" || attribute.name === "xlink:href";
}

/** The distinct IDs that an attribute names. */
function targetIds(attribute: KeptAttribute): string[] {
  if (isHref(attribute)) {
    const id = LOCAL_HREF.exec(attribute.value)?.[1];
    return id === undefined ? [] : [id];
  }
  const ids = new Set<string>();
  for (const match of attribute.value.matchAll(LOCAL_URL)) {
    if (match[1] !== undefined) ids.add(match[1]);
  }
  return [...ids];
}

/** `fill`, `stroke`, and the marker properties pass down to children. */
type InheritedKind = Extract<ReferenceKind, "paint" | "marker">;

function isInherited(kind: ReferenceKind): kind is InheritedKind {
  return kind === "paint" || kind === "marker";
}

function isHost(owner: PlannedElement, kind: InheritedKind, shape: SubtreeShape): boolean {
  const hosts = kind === "paint" ? PAINT_HOSTS : MARKER_HOSTS;
  return hosts.has(owner.tagName) && shape.hostable;
}

function copiesOf(
  owner: PlannedElement,
  attribute: KeptAttribute,
  kind: ReferenceKind,
  shape: SubtreeShape,
): number {
  // A pattern paints the host and each text run below it.
  if (kind === "paint") return shape.size;
  if (kind !== "marker") return 1;
  return attribute.name === "marker-mid" ? vertexBound(owner) : subpathBound(owner);
}

/** At most one vertex per number or command, plus the start. */
function vertexBound(owner: PlannedElement): number {
  if (owner.tagName === "line") return 2;
  if (owner.tagName === "path") {
    const d = attributeValue(owner, "d");
    return countOf(d, PATH_NUMBER) + countOf(d, PATH_COMMAND) + 1;
  }
  return countOf(attributeValue(owner, "points"), PATH_NUMBER) + 1;
}

/** Each moveto or closepath can start a subpath; browsers may mark each one. */
function subpathBound(owner: PlannedElement): number {
  if (owner.tagName !== "path") return 1;
  return Math.max(1, countOf(attributeValue(owner, "d"), SUBPATH_COMMAND));
}

function attributeValue(element: PlannedElement, name: string): string {
  const attribute = element.attributes.find((each) => each.name === name && !each.dropped);
  return attribute?.value ?? "";
}

function countOf(value: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of value.matchAll(pattern)) count++;
  return count;
}

function groupByOwner(references: readonly DrawReference[]): Map<PlannedElement, DrawReference[]> {
  const byOwner = new Map<PlannedElement, DrawReference[]>();
  for (const reference of references) {
    const list = byOwner.get(reference.owner);
    if (list) list.push(reference);
    else byOwner.set(reference.owner, [reference]);
  }
  return byOwner;
}

/**
 * Sets `drawn` on every reference that is not cut. Cycles are found as
 * strongly connected components of the graph of children, references, and
 * ID candidates. Every reference inside a component is on a cycle and is
 * cut. A cycle needs a reference, so what remains inside a component has no
 * cycle: children before parents (later in document order first), then IDs.
 */
function drawCosts(
  elements: readonly PlannedElement[],
  byOwner: ReadonlyMap<PlannedElement, readonly DrawReference[]>,
): void {
  const referencesOf = (element: PlannedElement) => byOwner.get(element) ?? [];
  const successors = (node: CostNode): readonly CostNode[] =>
    isIdTarget(node)
      ? node.candidates
      : [...childElements(node), ...referencesOf(node).map((reference) => reference.target)];
  const positions = new Map(elements.map((element, index) => [element, index]));
  const costs = new Map<CostNode, number>();
  const costOf = (node: CostNode) => costs.get(node) ?? COST_CAP;

  for (const component of stronglyConnectedComponents<CostNode>(elements, successors)) {
    const members = new Set(component);
    const memberElements = component.filter((node): node is PlannedElement => !isIdTarget(node));
    for (const member of memberElements) {
      for (const reference of referencesOf(member)) {
        if (members.has(reference.target)) reference.cut = true;
      }
    }
    memberElements.sort((left, right) => (positions.get(right) ?? 0) - (positions.get(left) ?? 0));
    for (const element of memberElements) {
      costs.set(element, elementCost(element, referencesOf(element), costOf));
    }
    for (const node of component) {
      // A browser draws one element of the ID: at most the costliest one.
      if (isIdTarget(node)) costs.set(node, highestCost(node.candidates, costOf));
    }
  }
}

/** One draw of `element`: itself, its children, and its references. */
function elementCost(
  element: PlannedElement,
  own: readonly DrawReference[],
  costOf: (node: CostNode) => number,
): number {
  let cost = 1;
  for (const child of childElements(element)) cost = capped(cost + costOf(child));
  // Marker copies can repeat the owner's pattern paint (context-fill).
  let paint = 0;
  for (const reference of own) {
    if (reference.kind !== "paint" || reference.cut) continue;
    paint = capped(paint + costOf(reference.target));
  }
  for (const reference of own) {
    if (reference.cut) continue;
    const perCopy =
      reference.kind === "marker"
        ? capped(costOf(reference.target) * (1 + paint))
        : costOf(reference.target);
    reference.drawn = capped(reference.copies * perCopy);
    cost = capped(cost + reference.drawn);
  }
  return cost;
}

/** A loop, not `Math.max(...)`: an ID can have more elements than a call takes arguments. */
function highestCost(
  candidates: readonly PlannedElement[],
  costOf: (node: CostNode) => number,
): number {
  let highest = 0;
  for (const candidate of candidates) highest = Math.max(highest, costOf(candidate));
  return highest;
}

function isIdTarget(node: CostNode): node is IdTarget {
  return "candidates" in node;
}

/** Spends the budget in document order; a reference that does not fit is cut. */
function cutOverBudget(references: readonly DrawReference[]): void {
  let remaining = MAX_DRAWN_BY_REFERENCES;
  for (const reference of references) {
    if (reference.cut) continue;
    if (reference.drawn > remaining) {
      reference.cut = true;
      continue;
    }
    remaining -= reference.drawn;
  }
}

/** Returns the number of elements and attributes that the cuts removed. */
function applyCuts(references: readonly DrawReference[]): number {
  const removed = new Set<PlannedElement | KeptAttribute>();
  for (const reference of references) {
    if (!reference.cut) continue;
    if (reference.kind === "use") {
      reference.owner.dropped = true;
      removed.add(reference.owner);
    } else {
      reference.attribute.dropped = true;
      removed.add(reference.attribute);
    }
  }
  return removed.size;
}

function capped(value: number): number {
  return Math.min(value, COST_CAP);
}

interface TarjanState {
  index: number;
  low: number;
  onStack: boolean;
}

interface TarjanFrame<Node> {
  node: Node;
  state: TarjanState;
  edges: readonly Node[];
  position: number;
}

/**
 * Tarjan's algorithm without recursion: reference chains can be far deeper
 * than the call stack. Components come out sinks first, so every successor
 * outside a component has its cost before the component is evaluated.
 */
function stronglyConnectedComponents<Node extends object>(
  roots: readonly Node[],
  successors: (node: Node) => readonly Node[],
): Node[][] {
  const states = new Map<Node, TarjanState>();
  const stack: Node[] = [];
  const components: Node[][] = [];
  let nextIndex = 0;

  for (const start of roots) {
    if (states.has(start)) continue;
    const frames: Array<TarjanFrame<Node>> = [];
    const open = (node: Node) => {
      const state = { index: nextIndex, low: nextIndex, onStack: true };
      nextIndex++;
      states.set(node, state);
      stack.push(node);
      frames.push({ node, state, edges: successors(node), position: 0 });
    };
    open(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      const target = frame.edges[frame.position];
      if (target !== undefined) {
        frame.position++;
        const seen = states.get(target);
        if (!seen) open(target);
        else if (seen.onStack) frame.state.low = Math.min(frame.state.low, seen.index);
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) parent.state.low = Math.min(parent.state.low, frame.state.low);
      if (frame.state.low !== frame.state.index) continue;
      const component: Node[] = [];
      for (let member = stack.pop(); member; member = stack.pop()) {
        const state = states.get(member);
        if (state) state.onStack = false;
        component.push(member);
        if (member === frame.node) break;
      }
      components.push(component);
    }
  }
  return components;
}
