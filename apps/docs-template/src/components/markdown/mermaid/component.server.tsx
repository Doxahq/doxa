import { createMermaid } from "@doxahq/docs-prose";

/**
 * The server never draws a diagram: `createMermaid` renders in an effect, so
 * the server HTML holds only the placeholder. This stub keeps the `mermaid`
 * library, about 7 MB of server modules, out of the server bundle. Dynamic
 * Workers compile every module on a cold start, used or not.
 */
export default createMermaid({
  initialize() {
    // Nothing to configure: the server draws no diagram.
  },
  render: () =>
    Promise.reject(new Error("Mermaid diagrams render in the browser.")),
});
