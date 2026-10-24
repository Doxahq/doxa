import { createMermaid } from "@doxahq/docs-prose";
import mermaid from "mermaid";

/**
 * The diagram of the published docs. The markup lives in `@doxahq/docs-prose`,
 * so the dashboard editor draws the same diagram. This module stays behind the
 * lazy import in `./index`, so `mermaid` loads only on a page with a diagram.
 */
export default createMermaid(mermaid);
