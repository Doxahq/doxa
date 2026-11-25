import { createMermaid } from "@doxahq/docs-prose";
import { render } from "pele";

/**
 * The diagram of the published docs. The markup lives in `@doxahq/docs-prose`,
 * so the dashboard editor draws the same diagram. Pele draws without a DOM, so
 * the server HTML holds the finished SVG. This module stays behind the lazy
 * import in `./index`, so the browser loads `pele` only on a page with a
 * diagram.
 */
export default createMermaid({ render });
