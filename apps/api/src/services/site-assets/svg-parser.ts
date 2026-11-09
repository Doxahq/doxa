/// <reference path="./xmldom-dom-parser.d.ts" />
import { DOMParser, onErrorStopParsing, type Document } from "@xmldom/xmldom";
import { __DOMHandler } from "@xmldom/xmldom/lib/dom-parser";

/** Levels of elements below the root. A real image stays far under it. */
const MAX_DEPTH = 64;

/** More than the allowlists hold. A real element has a few dozen at most. */
const MAX_ATTRIBUTES_PER_ELEMENT = 256;

/**
 * Elements of one file, with the root. The parsed tree must fit the heap of
 * an isolated cleaner (512 MB), and every runtime must decide the same way.
 */
const MAX_ELEMENTS = 100_000;

/**
 * The parser's work grows with the square of two values: a namespace lookup
 * walks every ancestor that declares a namespace, and adding an attribute
 * searches the attributes before it. So this handler enforces both limits
 * while the parser runs, on the elements that the parser really sees. It
 * throws, and `onErrorStopParsing` ends the parse. It also limits the number
 * of elements, which sets the memory that the parsed tree needs.
 */
class BoundedDomHandler extends __DOMHandler {
  private depth = 0;
  private elements = 0;

  override startElement(
    namespaceURI: string | undefined,
    localName: string,
    qName: string,
    attributes: { readonly length: number },
  ): void {
    if (this.depth > MAX_DEPTH) throw new Error("The SVG nests too many elements.");
    if (++this.elements > MAX_ELEMENTS) throw new Error("The SVG has too many elements.");
    if (attributes.length > MAX_ATTRIBUTES_PER_ELEMENT) {
      throw new Error("An SVG element has too many attributes.");
    }
    this.depth++;
    super.startElement(namespaceURI, localName, qName, attributes);
  }

  override endElement(namespaceURI: string | undefined, localName: string, qName: string): void {
    this.depth--;
    super.endElement(namespaceURI, localName, qName);
  }
}

/** Parses SVG text, with work linear in its length. Throws on any invalid input. */
export function parseSvgDocument(input: string): Document {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(input)) {
    throw new Error("Unsupported SVG declaration.");
  }
  return new DOMParser({
    onError: onErrorStopParsing,
    domHandler: BoundedDomHandler,
  }).parseFromString(input, "image/svg+xml");
}
