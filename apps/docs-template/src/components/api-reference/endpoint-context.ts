import { createContext, useContext } from "react";

/**
 * True while the reference layout renders the endpoint chrome — the method and
 * path bar, the code samples, and the playground.
 *
 * The generator wraps every endpoint page in one `<ApiEndpoint>` block. On a
 * reference page the layout owns that chrome, so the block renders its children
 * only. Anywhere else the block draws its own compact frame.
 */
export const EndpointChromeContext = createContext(false);

export function useLayoutOwnsEndpointChrome(): boolean {
  return useContext(EndpointChromeContext);
}
