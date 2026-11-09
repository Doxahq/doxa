/** The default DOM builder of xmldom. Its package publishes no types for it. */
declare module "@xmldom/xmldom/lib/dom-parser" {
  export class __DOMHandler {
    startElement(
      namespaceURI: string | undefined,
      localName: string,
      qName: string,
      attributes: { readonly length: number },
    ): void;
    endElement(namespaceURI: string | undefined, localName: string, qName: string): void;
  }
}
